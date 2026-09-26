import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  canAccessBranch,
  hasAllBranches,
  scopedBranchIds,
} from '../auth/branch-scope';
import { DataSource, In } from 'typeorm';
import { Sale } from '../database/entities/sale.entity';
import {
  ExchangeLink,
  ExchangeStatus,
} from '../database/entities/exchange-link.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { AuditService } from '../audit/audit.service';
import { SalesService } from '../sales/sales.service';
import {
  ensureSpecialMethod,
  EXCHANGE_CREDIT_CODE,
} from '../sales/special-tenders';
import { paginate } from '../common/dto/pagination.dto';
import { ReturnsService } from './returns.service';
import {
  CancelExchangeDto,
  CompleteExchangeDto,
  CreateExchangeDto,
  ExchangeSaleInput,
  ListExchangesQueryDto,
} from './returns.dto';

export interface ExchangeResult {
  exchange: ExchangeLink;
  saleReturn: Awaited<ReturnType<ReturnsService['findOne']>>;
  sale: Sale | null;
  // Why the replacement sale failed (the exchange is then incomplete)
  error: string | null;
}

const cents = (v: number) => Math.round(v * 100);

const isApprovable = (error: unknown) =>
  error instanceof ForbiddenException &&
  !!(error.getResponse() as { approvable?: boolean })?.approvable;

/**
 * Exchanges (spec §12): a return plus a replacement sale linked by an
 * exchange_links row. The returned value pays for the new sale (EXCHANGE_CREDIT
 * tender); a difference is paid with the tenders sent, or refunded on the return.
 * If the replacement sale fails, the return stands and the exchange is
 * incomplete: resubmitting the same request (same key) or completing it later
 * rings the sale up again, or it is cancelled and its credit refunded. A
 * replacement worth less than the credit gets the rest of the credit refunded
 * in the same completion.
 */
@Injectable()
export class ExchangesService {
  private readonly logger = new Logger(ExchangesService.name);

  constructor(
    private dataSource: DataSource,
    private returnsService: ReturnsService,
    private salesService: SalesService,
    private auditService: AuditService,
  ) {}

  async create(
    tenantId: string,
    user: AuthUser,
    dto: CreateExchangeDto,
    approvalToken?: string,
  ): Promise<ExchangeResult> {
    this.assertCanSell(user);
    const original = await this.dataSource
      .getRepository(Sale)
      .findOne({ where: { id: dto.saleId, tenantId } });
    // Only sales of the user's branches (spec §9)
    if (!original || !canAccessBranch(original.branchId)) {
      throw new NotFoundException('Sale not found');
    }
    const customerId =
      dto.newSale.customerId ?? original.customerId ?? undefined;

    // Price the replacement first: its total decides how much of the return pays for it
    const quote = await this.salesService.quote(
      tenantId,
      user,
      {
        registerId: dto.registerId,
        customerId,
        discountCode: dto.newSale.discountCode,
        cartDiscount: dto.newSale.cartDiscount,
        items: dto.newSale.items,
        giftCards: dto.newSale.giftCards,
      },
      approvalToken,
    );

    // Recorded once per key: a resubmission gets the same return back
    const saleReturn = await this.returnsService.create(
      tenantId,
      user,
      {
        saleId: dto.saleId,
        registerId: dto.registerId,
        reason: dto.reason,
        items: dto.items,
        refundMethodId: dto.refundMethodId,
        refundToStoreCredit: dto.refundToStoreCredit,
        idempotencyKey: dto.idempotencyKey,
      },
      approvalToken,
      { exchange: { newSaleTotal: quote.total } },
    );
    const link = await this.dataSource
      .getRepository(ExchangeLink)
      .findOne({ where: { tenantId, returnId: saleReturn.id } });
    if (!link) {
      throw new ConflictException(
        'This key was already used for a return that is not an exchange',
      );
    }
    return this.ringUp(
      tenantId,
      user,
      link,
      dto.registerId,
      dto.newSale,
      approvalToken,
    );
  }

  /** Ring up the replacement sale of an incomplete exchange again */
  async complete(
    tenantId: string,
    user: AuthUser,
    id: string,
    dto: CompleteExchangeDto,
    approvalToken?: string,
  ): Promise<ExchangeResult> {
    this.assertCanSell(user);
    const link = await this.dataSource
      .getRepository(ExchangeLink)
      .findOne({ where: { id, tenantId } });
    if (!link) throw new NotFoundException('Exchange not found');
    await this.assertLinkBranch(link);
    return this.ringUp(
      tenantId,
      user,
      link,
      dto.registerId,
      dto.newSale,
      approvalToken,
    );
  }

  /**
   * Give up an incomplete exchange: its whole credit is refunded (original
   * payments by default, a chosen method, or store credit; another tender than
   * the sale's needs sales.refund.any_method or a manager's approval).
   */
  async cancel(
    tenantId: string,
    user: AuthUser,
    id: string,
    dto: CancelExchangeDto,
    approvalToken?: string,
  ): Promise<ExchangeResult> {
    const link = await this.dataSource
      .getRepository(ExchangeLink)
      .findOne({ where: { id, tenantId } });
    if (!link) throw new NotFoundException('Exchange not found');
    await this.assertLinkBranch(link);
    if (link.status !== ExchangeStatus.INCOMPLETE) {
      throw new ConflictException(
        'Only an incomplete exchange can be cancelled',
      );
    }
    const cancelled = await this.returnsService.releaseExchangeCredit(
      tenantId,
      user,
      {
        exchangeId: link.id,
        amount: 'all',
        registerId: dto.registerId,
        reason: dto.reason,
        refundMethodId: dto.refundMethodId,
        refundToStoreCredit: dto.refundToStoreCredit,
        customerId: dto.customerId,
        cancel: true,
      },
      approvalToken,
    );
    return this.result(tenantId, cancelled, null);
  }

  async findAll(tenantId: string, query: ListExchangesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const qb = this.dataSource
      .getRepository(ExchangeLink)
      .createQueryBuilder('x')
      .leftJoinAndSelect('x.saleReturn', 'ret')
      .where('x.tenantId = :tenantId', { tenantId })
      .orderBy('x.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.status)
      qb.andWhere('x.status = :status', { status: query.status });
    // Exchanges of the user's branches' sales (spec §9)
    const scope = scopedBranchIds();
    if (scope) {
      qb.andWhere(
        'x.originalSaleId IN (SELECT xs.id FROM sales xs WHERE xs."branchId" = ANY(:exchangeBranches))',
        { exchangeBranches: scope },
      );
    }
    const [data, total] = await qb.getManyAndCount();
    return paginate(data, total, page, limit);
  }

  async findOne(tenantId: string, id: string): Promise<ExchangeResult> {
    const link = await this.dataSource
      .getRepository(ExchangeLink)
      .findOne({ where: { id, tenantId } });
    if (!link) throw new NotFoundException('Exchange not found');
    await this.assertLinkBranch(link);
    return this.result(tenantId, link, null);
  }

  /** Another branch's exchange (by its original sale) is "not found" */
  private async assertLinkBranch(link: ExchangeLink) {
    if (hasAllBranches()) return;
    const sale = await this.dataSource.getRepository(Sale).findOne({
      where: { id: link.originalSaleId, tenantId: link.tenantId },
      select: { id: true, branchId: true },
    });
    if (!canAccessBranch(sale?.branchId)) {
      throw new NotFoundException('Exchange not found');
    }
  }

  private assertCanSell(user: AuthUser) {
    if (!user.permissions?.includes('pos.sell')) {
      throw new ForbiddenException({
        message: 'You do not have permission to perform this action',
        error: 'Forbidden',
        missingPermissions: ['pos.sell'],
        approvable: false,
      });
    }
  }

  private async ringUp(
    tenantId: string,
    user: AuthUser,
    link: ExchangeLink,
    registerId: string,
    newSale: ExchangeSaleInput,
    approvalToken?: string,
  ): Promise<ExchangeResult> {
    if (
      link.status === ExchangeStatus.COMPLETED ||
      link.status === ExchangeStatus.CANCELLED
    ) {
      return this.result(tenantId, link, null);
    }
    let credit = Number(link.creditAmount);
    const original = await this.dataSource
      .getRepository(Sale)
      .findOne({ where: { id: link.originalSaleId, tenantId } });
    const customerId = newSale.customerId ?? original?.customerId ?? undefined;
    try {
      const quote =
        credit > 0 || newSale.differenceMethodId
          ? await this.salesService.quote(
              tenantId,
              user,
              {
                registerId,
                customerId,
                discountCode: newSale.discountCode,
                cartDiscount: newSale.cartDiscount,
                items: newSale.items,
                giftCards: newSale.giftCards,
              },
              approvalToken,
            )
          : null;
      // Worth less than the credit: the rest of the credit is refunded first
      // (the sale must use its credit in full)
      if (quote && cents(quote.total) < cents(credit)) {
        const updated = await this.returnsService.releaseExchangeCredit(
          tenantId,
          user,
          {
            exchangeId: link.id,
            amount: (cents(credit) - cents(quote.total)) / 100,
            registerId,
            reason: 'Replacement worth less than the exchange credit',
            refundMethodId: newSale.creditRefundMethodId,
            refundToStoreCredit: newSale.creditToStoreCredit,
            customerId,
            cancel: false,
          },
          approvalToken,
        );
        credit = Number(updated.creditAmount);
      }
      const creditMethod =
        credit > 0
          ? await ensureSpecialMethod(
              this.dataSource.manager,
              tenantId,
              EXCHANGE_CREDIT_CODE,
            )
          : null;
      // The exact difference left after the credit and the tenders sent
      const differencePayment =
        quote && newSale.differenceMethodId
          ? this.differencePayment(quote.total, newSale, credit)
          : [];
      await this.salesService.create(
        tenantId,
        user,
        {
          registerId,
          customerId,
          salespersonId: newSale.salespersonId,
          discountCode: newSale.discountCode,
          cartDiscount: newSale.cartDiscount,
          items: newSale.items,
          giftCards: newSale.giftCards,
          notes: newSale.notes,
          payments: [
            ...(creditMethod
              ? [{ paymentMethodId: creditMethod.id, amount: credit }]
              : []),
            ...newSale.payments,
            ...differencePayment,
          ],
          // One replacement sale per exchange
          idempotencyKey: `exchange:${link.id}`,
        },
        approvalToken,
        {
          exchange: {
            linkId: link.id,
            creditAmount: credit,
            originalSaleId: link.originalSaleId,
          },
        },
      );
    } catch (error) {
      const message = (error as Error).message?.slice(0, 500) ?? 'Failed';
      // The return stands; the exchange waits for its replacement sale
      await this.dataSource.getRepository(ExchangeLink).update(
        {
          id: link.id,
          tenantId,
          status: In([ExchangeStatus.PENDING, ExchangeStatus.INCOMPLETE]),
        },
        { status: ExchangeStatus.INCOMPLETE, failureReason: message },
      );
      await this.auditService.record({
        tenantId,
        action: 'exchange.incomplete',
        entityType: 'sale_return',
        entityId: link.returnId,
        reason: message,
        metadata: { exchangeId: link.id },
      });
      this.logger.warn(
        `Exchange ${link.id}: replacement sale failed: ${message}`,
      );
      // A manager can approve and the till retries the same request
      if (isApprovable(error)) throw error;
      const fresh = await this.dataSource
        .getRepository(ExchangeLink)
        .findOneOrFail({ where: { id: link.id, tenantId } });
      return this.result(tenantId, fresh, message);
    }
    const done = await this.dataSource
      .getRepository(ExchangeLink)
      .findOneOrFail({ where: { id: link.id, tenantId } });
    await this.auditService.record({
      tenantId,
      action: 'exchange.completed',
      entityType: 'sale_return',
      entityId: done.returnId,
      metadata: {
        exchangeId: done.id,
        newSaleId: done.newSaleId,
        difference: Number(done.difference),
      },
    });
    return this.result(tenantId, done, null);
  }

  /** The payment that covers what is left to pay of the priced replacement */
  private differencePayment(
    total: number,
    newSale: ExchangeSaleInput,
    credit: number,
  ): { paymentMethodId: string; amount: number }[] {
    const left =
      cents(total) -
      cents(credit) -
      newSale.payments.reduce((sum, p) => sum + cents(p.amount), 0);
    return left > 0
      ? [{ paymentMethodId: newSale.differenceMethodId!, amount: left / 100 }]
      : [];
  }

  private async result(
    tenantId: string,
    link: ExchangeLink,
    error: string | null,
  ): Promise<ExchangeResult> {
    return {
      exchange: link,
      saleReturn: await this.returnsService.findOne(tenantId, link.returnId),
      sale: link.newSaleId
        ? await this.salesService.findOne(tenantId, link.newSaleId)
        : null,
      error:
        error ??
        (link.status === ExchangeStatus.INCOMPLETE ? link.failureReason : null),
    };
  }
}
