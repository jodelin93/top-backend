import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  assertBranchAccess,
  assertLocationAccess,
  branchFilterSql,
  branchScope,
  canAccessBranch,
} from '../auth/branch-scope';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  addQty,
  QuantityUnit,
  quantityError,
  subQty,
} from '../common/utils/quantity';
import { Sale, SaleStatus } from '../database/entities/sale.entity';
import { SaleItem } from '../database/entities/sale-item.entity';
import { Payment, PaymentStatus } from '../database/entities/payment.entity';
import {
  PaymentMethod,
  PaymentMethodStatus,
  PaymentMethodType,
} from '../database/entities/payment-method.entity';
import { Register, RegisterStatus } from '../database/entities/register.entity';
import { InventoryLocation } from '../database/entities/inventory-location.entity';
import { MovementType } from '../database/entities/stock-movement.entity';
import { CashMovementType } from '../database/entities/cash-movement.entity';
import {
  ReturnStatus,
  ReturnType,
  SaleReturn,
} from '../database/entities/sale-return.entity';
import { Customer } from '../database/entities/customer.entity';
import {
  ExchangeLink,
  ExchangeStatus,
} from '../database/entities/exchange-link.entity';
import { CustomerCreditService } from '../customers/credit/customer-credit.service';
import { StoredValueService } from '../stored-value/stored-value.service';
import { OutboxService } from '../platform/outbox/outbox.service';
import {
  ensureSpecialMethod,
  EXCHANGE_CREDIT_CODE,
  GIFT_CARD_CODE,
  ON_ACCOUNT_CODE,
  SpecialTenderCode,
  specialTenderOf,
  STORE_CREDIT_CODE,
} from '../sales/special-tenders';
import {
  ReturnDisposition,
  SaleReturnItem,
} from '../database/entities/sale-return-item.entity';
import {
  RefundStatus,
  SaleReturnRefund,
} from '../database/entities/sale-return-refund.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import type { Permission } from '../auth/permissions';
import { approvalRequired } from '../sales/sale-authorization';
import { round2 } from '../sales/sale-calculator';
import {
  branchDocumentPrefix,
  nextDocumentNumber,
} from '../common/utils/sequence';
import { Branch } from '../database/entities/branch.entity';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { paginate, PaginatedResult } from '../common/dto/pagination.dto';
import { SettingsService } from '../settings/settings.service';
import { InventoryService } from '../inventory/inventory.service';
import { ShiftsService } from '../shifts/shifts.service';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { PaymentProviderRegistry } from '../payments/providers/provider-registry';
import { requestContext } from '../common/context/request-context';
import {
  LOYALTY_METHOD_CODE,
  LoyaltyService,
} from '../loyalty/loyalty.service';
import {
  allocateToOriginalTenders,
  lineRefund,
  onAccountShare,
  RefundablePayment,
  saleAgeDays,
} from './return-math';
import { matchesReturnRequest } from './return-request';
import { CreateReturnDto, ListReturnsQueryDto } from './returns.dto';
import { containsPattern } from '../common/utils/like';

// Sales that can still be returned
const RETURNABLE_STATUSES = [
  SaleStatus.COMPLETED,
  SaleStatus.PARTIALLY_REFUNDED,
];
// Payments that actually took money
const PAID_STATUSES = [PaymentStatus.COMPLETED, PaymentStatus.CAPTURED];
// Rounding tolerance when comparing money
const CENT = 0.01;

const cents = (value: number) => Math.round(value * 100);

// Gift cards sold on a sale: stored value, never stock
const isStoredValueLine = (item: Pick<SaleItem, 'metadata'>) =>
  item.metadata?.storedValue === true;

/** Internal options of create() (not part of the API request) */
/** Part (or all) of an exchange's credit given back as a refund */
export interface ExchangeCreditRelease {
  exchangeId: string;
  // 'all': the whole credit (cancelling the exchange)
  amount: number | 'all';
  registerId: string;
  reason: string;
  refundMethodId?: string;
  refundToStoreCredit?: boolean;
  customerId?: string;
  // Close the exchange (no replacement sale)
  cancel: boolean;
}

export interface ReturnCreateOptions {
  // The return leg of an exchange: its value pays for the replacement sale
  exchange?: { newSaleTotal: number };
}

/** How one part of a refund is paid */
export interface PlannedRefund {
  paymentMethodId: string;
  amount: number;
  isCash: boolean;
  originalPaymentId: string | null;
  provider: string | null;
  providerReference: string | null;
  // On account → credit note; store credit / gift card → stored value; exchange credit
  special: SpecialTenderCode | null;
  // Gift card / store credit account the original payment was taken from
  storedValueAccountId: string | null;
}

export interface ReturnableLine {
  saleItemId: string;
  variantId: string;
  sku: string;
  productName: string;
  variantName: string | null;
  quantitySold: number;
  quantityReturned: number;
  quantityReturnable: number;
  unit: string | null;
  unitPrecision: number | null;
  unitPrice: number;
  // Refund per unit (tax and discounts included), for display
  refundPerUnit: number;
}

@Injectable()
export class ReturnsService {
  private readonly logger = new Logger(ReturnsService.name);

  constructor(
    @InjectRepository(SaleReturn)
    private returnRepository: Repository<SaleReturn>,
    private dataSource: DataSource,
    private settingsService: SettingsService,
    private inventoryService: InventoryService,
    private shiftsService: ShiftsService,
    private auditService: AuditService,
    private approvalsService: ApprovalsService,
    private providers: PaymentProviderRegistry,
    private loyaltyService: LoyaltyService,
    private customerCredit: CustomerCreditService,
    private storedValue: StoredValueService,
    @Optional() private outbox?: OutboxService,
  ) {}

  /**
   * Everything needed to start a return: the sale, what can still be returned,
   * the original payments, and whether the return window has passed
   */
  async lookupSale(tenantId: string, saleNumber: string) {
    const number = saleNumber.trim();
    const sale = await this.dataSource
      .getRepository(Sale)
      .createQueryBuilder('sale')
      .leftJoinAndSelect('sale.items', 'items')
      .leftJoinAndSelect('sale.payments', 'payments')
      .leftJoinAndSelect('payments.paymentMethod', 'paymentMethod')
      .leftJoinAndSelect('sale.customer', 'customer')
      .where('sale.tenantId = :tenantId', { tenantId })
      .andWhere(
        '(UPPER(sale.saleNumber) = UPPER(:number) OR UPPER(sale.offlineNumber) = UPPER(:number))',
        {
          number,
        },
      )
      .orderBy('items.lineNumber', 'ASC')
      .getOne();
    // Only sales of the user's branches can be looked up (spec §9)
    if (!sale || !canAccessBranch(sale.branchId)) {
      throw new NotFoundException(`No sale found with number ${number}`);
    }

    const returned = await this.returnedQuantities(
      this.dataSource.manager,
      sale.id,
    );
    const { returnWindowDays } =
      await this.settingsService.getSettings(tenantId);
    const ageDays = saleAgeDays(sale);
    const previousReturns = await this.returnRepository.find({
      where: { tenantId, originalSaleId: sale.id },
      order: { createdAt: 'ASC' },
    });

    return {
      sale,
      returnable: RETURNABLE_STATUSES.includes(sale.status),
      outsideReturnWindow: ageDays > returnWindowDays,
      returnWindowDays,
      lines: sale.items.map((item): ReturnableLine => {
        const already = returned.get(item.id) ?? 0;
        return {
          saleItemId: item.id,
          variantId: item.variantId,
          sku: item.sku,
          productName: item.productName,
          variantName: item.variantName ?? null,
          quantitySold: item.quantity,
          quantityReturned: already,
          quantityReturnable: subQty(item.quantity, already),
          unitPrice: Number(item.unitPrice),
          refundPerUnit: round2(Number(item.total) / Number(item.quantity)),
          // Measured item: decimals allowed up to the unit's precision
          unit: (item.metadata?.unit as string | undefined) ?? null,
          unitPrecision:
            (item.metadata?.unitPrecision as number | undefined) ?? null,
        };
      }),
      previousReturns,
    };
  }

  /**
   * Process a return: validates quantities against what's left to return (row-locked,
   * so concurrent returns can't over-refund), restocks or disposes each item, refunds
   * cash from the register's open shift and card payments through their provider.
   */
  async create(
    tenantId: string,
    user: AuthUser,
    dto: CreateReturnDto,
    approvalToken?: string,
    options: ReturnCreateOptions = {},
  ): Promise<SaleReturn> {
    const existing = await this.returnRepository.findOne({
      where: { tenantId, idempotencyKey: dto.idempotencyKey },
    });
    if (existing) return this.replay(tenantId, existing.id, dto, options);

    // Manager approvals (X-Approval-Token, comma-separated when several are needed)
    const tokens = (approvalToken ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const refundApproverId = await this.authorize(
      user,
      'sales.refund',
      tokens,
      'You do not have permission to perform this action',
    );

    const goodwill = dto.type === 'goodwill';
    if (goodwill) {
      if (dto.items.length) {
        throw new BadRequestException('A goodwill refund has no items');
      }
      if (!dto.goodwillAmount) {
        throw new BadRequestException(
          'Enter the amount of the goodwill refund',
        );
      }
      if (options.exchange) {
        throw new BadRequestException('An exchange returns goods');
      }
    } else if (!dto.items.length) {
      throw new BadRequestException('Choose the items that come back');
    }
    // Money back without goods: its own permission, or a manager's approval
    const goodwillApproverId = goodwill
      ? await this.authorize(
          user,
          'sales.refund.goodwill',
          tokens,
          "A goodwill refund (money back without goods) needs a manager's approval",
        )
      : null;

    const saleItemIds = dto.items.map((i) => i.saleItemId);
    if (new Set(saleItemIds).size !== saleItemIds.length) {
      throw new BadRequestException(
        'Each sale line can only appear once in a return',
      );
    }

    let returnId: string;
    try {
      returnId = await this.dataSource.transaction(async (manager) => {
        // Lock the sale: every return of this sale is serialised from here on
        const sale = await manager.findOne(Sale, {
          where: { id: dto.saleId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!sale || !canAccessBranch(sale.branchId)) {
          throw new NotFoundException('Sale not found');
        }
        if (!RETURNABLE_STATUSES.includes(sale.status)) {
          throw new ConflictException(
            `This sale is ${sale.status} and can't be returned`,
          );
        }

        const windowApproverId = await this.checkReturnWindow(
          tenantId,
          user,
          sale,
          tokens,
        );

        const register = await manager.findOne(Register, {
          where: { id: dto.registerId, tenantId },
        });
        if (!register || register.status !== RegisterStatus.ACTIVE) {
          throw new BadRequestException('Register not found or inactive');
        }
        // Refunded from a till of the user's branches
        assertBranchAccess(user, register.branchId, 'Register not found');

        // ---- Lines ----
        const saleItems = saleItemIds.length
          ? await manager.find(SaleItem, {
              where: { tenantId, saleId: sale.id, id: In(saleItemIds) },
            })
          : [];
        if (saleItems.length !== saleItemIds.length) {
          throw new BadRequestException(
            'Some lines do not belong to this sale',
          );
        }
        const byId = new Map(saleItems.map((i) => [i.id, i]));
        const returned = await this.returnedQuantities(manager, sale.id);

        const locationIds = new Set<string>();
        const lines = dto.items.map((input) => {
          const item = byId.get(input.saleItemId)!;
          // Every recorded return counts, including one whose refund failed: the goods
          // came back (stock was restocked or disposed), only the money is outstanding,
          // and it's recovered by retrying that refund (retryRefunds), not a new return.
          const already = returned.get(item.id) ?? 0;
          // Whole units, or decimals up to the unit's precision for a weighed line
          const unitError = quantityError(input.quantity, lineUnit(item));
          if (unitError) {
            throw new BadRequestException(`${item.productName}: ${unitError}`);
          }
          if (addQty(already, input.quantity) > Number(item.quantity)) {
            throw new BadRequestException(
              `Only ${subQty(item.quantity, already)} × ${item.productName} can still be returned`,
            );
          }
          // Restocked, and damaged goods kept (at the damaged / quarantine location)
          const keeps =
            input.disposition === ReturnDisposition.RESTOCK ||
            input.disposition === ReturnDisposition.DAMAGED;
          let locationId = keeps
            ? (input.locationId ?? register.defaultLocationId)
            : null;
          if (keeps && !locationId) {
            throw new BadRequestException(
              'Choose a stock location for restocked items',
            );
          }
          if (locationId) locationIds.add(locationId);
          // Gift cards and services have no stock
          if (
            isStoredValueLine(item) ||
            item.metadata?.stockTracked === false
          ) {
            locationId = null;
          }
          return {
            input,
            item,
            locationId,
            amounts: lineRefund(
              {
                quantity: item.quantity,
                subtotal: Number(item.subtotal),
                discountAmount: Number(item.discountAmount),
                taxAmount: Number(item.taxAmount),
                total: Number(item.total),
              },
              already,
              input.quantity,
            ),
          };
        });

        if (locationIds.size > 0) {
          const found = await manager.count(InventoryLocation, {
            where: { tenantId, id: In([...locationIds]) },
          });
          if (found !== locationIds.size)
            throw new BadRequestException('Stock location not found');
          // Only locations the user's branches work from (404 otherwise)
          for (const id of locationIds) {
            await assertLocationAccess(
              manager,
              tenantId,
              id,
              'Stock location not found',
              branchScope(user),
            );
          }
        }
        // Damaged goods go to the warehouse's damaged / quarantine location
        for (const line of lines) {
          if (
            line.input.disposition === ReturnDisposition.DAMAGED &&
            line.locationId
          ) {
            line.locationId =
              await this.inventoryService.resolveConditionLocation(
                manager,
                tenantId,
                line.locationId,
                'damaged',
              );
          }
        }

        const sum = (
          key: 'subtotal' | 'discountAmount' | 'taxAmount' | 'total',
        ) => round2(lines.reduce((acc, l) => acc + l.amounts[key], 0));
        const total = goodwill ? round2(dto.goodwillAmount!) : sum('total');

        // ---- Refund tenders ----
        const { refunds, otherTender } = await this.planRefunds(
          manager,
          tenantId,
          sale,
          total,
          dto,
          options.exchange,
        );

        // Money going somewhere the sale wasn't paid from (e.g. a card sale refunded
        // in cash) needs sales.refund.any_method, or a manager's approval
        const anyMethodApproverId = otherTender.length
          ? await this.authorize(
              user,
              'sales.refund.any_method',
              tokens,
              `Refunding to a different payment method than the sale was paid with needs a manager's approval (${otherTender.join('; ')})`,
            )
          : null;
        const approverId =
          goodwillApproverId ??
          windowApproverId ??
          anyMethodApproverId ??
          refundApproverId;
        if (approverId) requestContext.set({ approverId });

        const cashTotal = round2(
          refunds.filter((r) => r.isCash).reduce((a, r) => a + r.amount, 0),
        );
        const shift = await this.shiftsService.getOpenShift(
          tenantId,
          register.id,
          manager,
        );
        if (cashTotal > 0 && !shift) {
          throw new ConflictException(
            'Open a shift on this register to give a cash refund, or refund to another payment method',
          );
        }

        // ---- Records ----
        // Numbered per branch of the returning register (D017): MAIN-R-000001
        const returnBranch = await manager.findOne(Branch, {
          where: { id: register.branchId, tenantId },
        });
        const returnNumber = await nextDocumentNumber(manager, {
          table: 'sale_returns',
          column: 'returnNumber',
          tenantId,
          prefix: returnBranch
            ? `${branchDocumentPrefix(returnBranch.code)}-R`
            : 'RET',
        });

        const returnType = goodwill
          ? ReturnType.GOODWILL
          : options.exchange
            ? ReturnType.EXCHANGE
            : ReturnType.RETURN;
        const saleReturn = await manager.save(
          manager.create(SaleReturn, {
            tenantId,
            returnNumber,
            originalSaleId: sale.id,
            registerId: register.id,
            shiftId: shift?.id ?? null,
            customerId: sale.customerId ?? null,
            userId: user.id,
            approverId,
            reason: dto.reason,
            subtotal: goodwill ? total : sum('subtotal'),
            discountAmount: goodwill ? 0 : sum('discountAmount'),
            taxAmount: goodwill ? 0 : sum('taxAmount'),
            total,
            currencyCode: sale.currencyCode,
            status: refunds.some((r) => r.provider && r.provider !== 'manual')
              ? ReturnStatus.REFUND_PENDING
              : ReturnStatus.COMPLETED,
            idempotencyKey: dto.idempotencyKey,
            returnType,
          }),
        );

        if (lines.length) {
          await manager.save(
            lines.map((line) =>
              manager.create(SaleReturnItem, {
                tenantId,
                returnId: saleReturn.id,
                saleItemId: line.item.id,
                variantId: line.item.variantId,
                sku: line.item.sku,
                productName: line.item.productName,
                variantName: line.item.variantName ?? null,
                quantity: line.input.quantity,
                unitPrice: Number(line.item.unitPrice),
                ...line.amounts,
                disposition: line.input.disposition,
                locationId: line.locationId,
                reason: line.input.reason ?? null,
              }),
            ),
          );
        }

        await manager.save(
          refunds.map((refund, index) =>
            manager.create(SaleReturnRefund, {
              tenantId,
              returnId: saleReturn.id,
              paymentMethodId: refund.paymentMethodId,
              originalPaymentId: refund.originalPaymentId,
              amount: refund.amount,
              provider: refund.provider,
              providerReference: refund.providerReference,
              idempotencyKey: `return:${saleReturn.id}:${index}`,
              // Cash, manual terminal, account and stored value refunds are done on the spot
              status:
                refund.provider && refund.provider !== 'manual'
                  ? RefundStatus.PENDING
                  : RefundStatus.COMPLETED,
            }),
          ),
        );

        // ---- Stock (R094): restock, keep as damaged, or dispose ----
        for (const line of lines) {
          if (!line.locationId) continue;
          await this.inventoryService.applyMovement(manager, {
            tenantId,
            userId: user.id,
            variantId: line.item.variantId,
            locationId: line.locationId,
            delta: line.input.quantity,
            movementType: MovementType.RETURN,
            referenceType: 'return',
            referenceId: saleReturn.id,
            referenceNumber: returnNumber,
            // Comes back at what it cost when sold (keeps average/FIFO cost honest)
            cost: line.item.cost != null ? Number(line.item.cost) : undefined,
            notes: line.input.reason ?? dto.reason,
          });
        }

        // Gift cards sold on the sale and brought back: cancelled (only if unused)
        const giftCardLines = lines
          .filter((l) => isStoredValueLine(l.item))
          .map((l) => l.item.id);
        if (giftCardLines.length) {
          await this.storedValue.voidSaleGiftCards(manager, {
            tenantId,
            saleId: sale.id,
            saleItemIds: giftCardLines,
            returnId: saleReturn.id,
            note: `Return ${returnNumber}`,
          });
        }

        // ---- Account, store credit and gift card refunds ----
        await this.postSpecialRefunds(manager, {
          tenantId,
          sale,
          returnId: saleReturn.id,
          returnNumber,
          refunds,
          customerId: dto.customerId ?? null,
        });

        // ---- Cash out of the drawer ----
        if (cashTotal > 0 && shift) {
          await this.shiftsService.recordCashMovement(manager, {
            tenantId,
            shiftId: shift.id,
            type: CashMovementType.REFUND,
            amount: cashTotal,
            userId: user.id,
            approverId,
            reason: `Return ${returnNumber}`,
            sourceType: 'return',
            sourceId: saleReturn.id,
          });
        }

        // ---- Sale status and loyalty ----
        // A goodwill refund takes no goods back: the sale keeps its status
        if (!goodwill) {
          const fullyReturned = await this.isFullyReturned(manager, sale.id);
          await manager.update(
            Sale,
            { id: sale.id, tenantId },
            {
              status: fullyReturned
                ? SaleStatus.REFUNDED
                : SaleStatus.PARTIALLY_REFUNDED,
            },
          );
        }
        if (sale.customerId) {
          // Points earned on the refunded money come back off; points spent are given back
          const loyaltyMethod = await manager.findOne(PaymentMethod, {
            where: { tenantId, code: LOYALTY_METHOD_CODE },
          });
          const pointsRefundedAmount = round2(
            refunds
              .filter(
                (r) => loyaltyMethod && r.paymentMethodId === loyaltyMethod.id,
              )
              .reduce((a, r) => a + r.amount, 0),
          );
          await this.loyaltyService.onReturn(manager, {
            tenantId,
            customerId: sale.customerId,
            saleId: sale.id,
            returnId: saleReturn.id,
            moneyRefunded: round2(total - pointsRefundedAmount),
            pointsRefundedAmount,
            returnNumber,
          });
        }

        // ---- Exchange: the replacement sale is rung up next ----
        if (options.exchange) {
          const credit = refunds
            .filter((r) => r.special === EXCHANGE_CREDIT_CODE)
            .reduce((a, r) => a + r.amount, 0);
          await manager.insert(ExchangeLink, {
            tenantId,
            originalSaleId: sale.id,
            returnId: saleReturn.id,
            status: ExchangeStatus.PENDING,
            returnTotal: total,
            creditAmount: round2(credit),
            newSaleTotal: options.exchange.newSaleTotal,
            difference: round2(options.exchange.newSaleTotal - total),
            createdById: user.id,
          });
        }

        await this.auditService.record(
          {
            tenantId,
            action: goodwill ? 'sale.goodwill_refund' : 'sale.returned',
            entityType: 'sale',
            entityId: sale.id,
            reason: dto.reason,
            approverId,
            metadata: {
              approvals: {
                refund: refundApproverId,
                returnWindow: windowApproverId,
                otherTender: anyMethodApproverId,
                goodwill: goodwillApproverId,
              },
              returnType,
              otherTender,
              returnId: saleReturn.id,
              returnNumber,
              saleNumber: sale.saleNumber,
              total,
              items: lines.map((l) => ({
                sku: l.item.sku,
                quantity: l.input.quantity,
                disposition: l.input.disposition,
                locationId: l.locationId,
              })),
              refunds: refunds.map((r) => ({
                paymentMethodId: r.paymentMethodId,
                amount: r.amount,
              })),
            },
          },
          manager,
        );
        await this.outbox?.record(manager, {
          tenantId,
          type: 'return.completed',
          aggregateId: saleReturn.id,
          payload: {
            returnId: saleReturn.id,
            returnNumber,
            originalSaleId: sale.id,
            total,
            currencyCode: sale.currencyCode,
          },
        });

        return saleReturn.id;
      });
    } catch (error) {
      // Two submissions with the same key raced: return the one that won
      if (isPgError(error, PG_UNIQUE_VIOLATION, 'uq_return_idempotency')) {
        const winner = await this.returnRepository.findOneOrFail({
          where: { tenantId, idempotencyKey: dto.idempotencyKey },
        });
        return this.replay(tenantId, winner.id, dto, options);
      }
      throw error;
    }

    // Card refunds go to the provider after the return is safely recorded
    await this.processProviderRefunds(tenantId, returnId);
    return this.findOne(tenantId, returnId);
  }

  /**
   * Give back (part of) an exchange's credit — the returned goods' value kept for
   * the replacement sale — when the exchange is cancelled, or when the replacement
   * costs less than the credit. The return's EXCHANGE_CREDIT refund row shrinks by
   * the amount, which is refunded like any return: to the original payments by
   * default, to a chosen method (another tender than the sale's needs
   * sales.refund.any_method or a manager's approval) or to store credit. The
   * return's refunds still add up to its total. Returns the updated exchange.
   */
  async releaseExchangeCredit(
    tenantId: string,
    user: AuthUser,
    input: ExchangeCreditRelease,
    approvalToken?: string,
  ): Promise<ExchangeLink> {
    const tokens = (approvalToken ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const refundApproverId = await this.authorize(
      user,
      'sales.refund',
      tokens,
      'You do not have permission to perform this action',
    );
    const released = await this.dataSource.transaction(async (manager) => {
      const link = await manager.findOne(ExchangeLink, {
        where: { id: input.exchangeId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!link) throw new NotFoundException('Exchange not found');
      if (
        link.newSaleId ||
        ![ExchangeStatus.PENDING, ExchangeStatus.INCOMPLETE].includes(
          link.status,
        )
      ) {
        throw new ConflictException(
          `This exchange is ${link.status}: its credit can't be refunded`,
        );
      }
      // Same lock as create(): refunds of a sale are serialised
      const sale = await manager.findOne(Sale, {
        where: { id: link.originalSaleId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!sale || !canAccessBranch(sale.branchId)) {
        throw new NotFoundException('Exchange not found');
      }
      const credit = round2(Number(link.creditAmount));
      const amount =
        input.amount === 'all' ? credit : round2(Number(input.amount));
      if (amount <= 0 || cents(amount) > cents(credit)) {
        throw new BadRequestException(
          `Only ${credit.toFixed(2)} of exchange credit is left to refund`,
        );
      }

      const register = await manager.findOne(Register, {
        where: { id: input.registerId, tenantId },
      });
      if (!register || register.status !== RegisterStatus.ACTIVE) {
        throw new BadRequestException('Register not found or inactive');
      }
      assertBranchAccess(user, register.branchId, 'Register not found');

      const saleReturn = await manager.findOneOrFail(SaleReturn, {
        where: { id: link.returnId, tenantId },
      });
      const creditMethod = await ensureSpecialMethod(
        manager,
        tenantId,
        EXCHANGE_CREDIT_CODE,
      );
      const creditRow = await manager.findOne(SaleReturnRefund, {
        where: {
          tenantId,
          returnId: saleReturn.id,
          paymentMethodId: creditMethod.id,
        },
      });
      if (!creditRow || cents(Number(creditRow.amount)) < cents(amount)) {
        throw new ConflictException(
          'The exchange credit on the return does not match the exchange',
        );
      }
      // The credit shrinks first, so the refund below fits under the sale's cap
      const left = round2(Number(creditRow.amount) - amount);
      if (left > 0) {
        await manager.update(
          SaleReturnRefund,
          { id: creditRow.id, tenantId },
          { amount: left },
        );
      } else {
        await manager.delete(SaleReturnRefund, { id: creditRow.id, tenantId });
      }

      const { refunds, otherTender } = await this.planRefunds(
        manager,
        tenantId,
        sale,
        amount,
        {
          refundMethodId: input.refundMethodId,
          refundToStoreCredit: input.refundToStoreCredit,
          customerId: input.customerId,
        } as CreateReturnDto,
      );
      const anyMethodApproverId = otherTender.length
        ? await this.authorize(
            user,
            'sales.refund.any_method',
            tokens,
            `Refunding to a different payment method than the sale was paid with needs a manager's approval (${otherTender.join('; ')})`,
          )
        : null;
      const approverId = anyMethodApproverId ?? refundApproverId;
      if (approverId) requestContext.set({ approverId });

      const cashTotal = round2(
        refunds.filter((r) => r.isCash).reduce((a, r) => a + r.amount, 0),
      );
      const shift = await this.shiftsService.getOpenShift(
        tenantId,
        register.id,
        manager,
      );
      if (cashTotal > 0 && !shift) {
        throw new ConflictException(
          'Open a shift on this register to give a cash refund, or refund to another payment method',
        );
      }

      const existing = await manager.count(SaleReturnRefund, {
        where: { tenantId, returnId: saleReturn.id },
      });
      await manager.save(
        refunds.map((refund, index) =>
          manager.create(SaleReturnRefund, {
            tenantId,
            returnId: saleReturn.id,
            paymentMethodId: refund.paymentMethodId,
            originalPaymentId: refund.originalPaymentId,
            amount: refund.amount,
            provider: refund.provider,
            providerReference: refund.providerReference,
            idempotencyKey: `return:${saleReturn.id}:credit:${existing + index}`,
            status:
              refund.provider && refund.provider !== 'manual'
                ? RefundStatus.PENDING
                : RefundStatus.COMPLETED,
          }),
        ),
      );
      await this.postSpecialRefunds(manager, {
        tenantId,
        sale,
        returnId: saleReturn.id,
        returnNumber: saleReturn.returnNumber,
        refunds,
        customerId: input.customerId ?? null,
      });
      if (cashTotal > 0 && shift) {
        await this.shiftsService.recordCashMovement(manager, {
          tenantId,
          shiftId: shift.id,
          type: CashMovementType.REFUND,
          amount: cashTotal,
          userId: user.id,
          approverId,
          reason: `Exchange credit refunded (return ${saleReturn.returnNumber})`,
          sourceType: 'return',
          sourceId: saleReturn.id,
        });
      }

      const creditAmount = round2(credit - amount);
      const newSaleTotal = input.cancel ? 0 : creditAmount;
      await manager.update(
        ExchangeLink,
        { id: link.id, tenantId },
        {
          creditAmount,
          newSaleTotal,
          difference: round2(newSaleTotal - Number(link.returnTotal)),
          ...(input.cancel && {
            status: ExchangeStatus.CANCELLED,
            failureReason: null,
          }),
        },
      );
      await this.auditService.record(
        {
          tenantId,
          action: input.cancel
            ? 'exchange.cancelled'
            : 'exchange.credit_refunded',
          entityType: 'sale_return',
          entityId: saleReturn.id,
          reason: input.reason,
          approverId,
          metadata: {
            exchangeId: link.id,
            returnNumber: saleReturn.returnNumber,
            amount,
            creditLeft: creditAmount,
            otherTender,
            refunds: refunds.map((r) => ({
              paymentMethodId: r.paymentMethodId,
              amount: r.amount,
            })),
          },
        },
        manager,
      );
      return {
        returnId: saleReturn.id,
        pending: refunds.some((r) => r.provider && r.provider !== 'manual'),
      };
    });
    // Card refunds go to the provider once recorded (return status follows)
    if (released.pending) {
      await this.processProviderRefunds(tenantId, released.returnId);
    }
    return this.dataSource
      .getRepository(ExchangeLink)
      .findOneOrFail({ where: { id: input.exchangeId, tenantId } });
  }

  /**
   * Send pending/failed card refunds of a return to their provider again
   */
  async retryRefunds(tenantId: string, returnId: string): Promise<SaleReturn> {
    const saleReturn = await this.findOne(tenantId, returnId);
    if (saleReturn.status === ReturnStatus.COMPLETED) {
      return saleReturn;
    }
    await this.dataSource.transaction(async (manager) => {
      // Same lock as create(): retries and new returns of a sale are serialised
      const sale = await manager.findOne(Sale, {
        where: { id: saleReturn.originalSaleId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!sale) throw new NotFoundException('Sale not found');
      const failed = await manager.find(SaleReturnRefund, {
        where: { tenantId, returnId, status: RefundStatus.FAILED },
      });
      if (failed.length === 0) return;

      // A failed refund doesn't count toward the cap, so retrying it must fit under it
      // again: the sale's total, and what its original payment took
      const active = await this.activeRefunds(manager, tenantId, sale.id);
      const retrying = round2(failed.reduce((a, r) => a + Number(r.amount), 0));
      if (round2(active.total + retrying) > round2(Number(sale.total)) + CENT) {
        throw new ConflictException(
          'Retrying this refund would refund more than the customer paid for the sale',
        );
      }
      const paymentIds = [
        ...new Set(failed.map((r) => r.originalPaymentId).filter(Boolean)),
      ] as string[];
      const payments = paymentIds.length
        ? await manager.find(Payment, {
            where: { tenantId, id: In(paymentIds) },
          })
        : [];
      for (const payment of payments) {
        const again = failed
          .filter((r) => r.originalPaymentId === payment.id)
          .reduce((a, r) => a + Number(r.amount), 0);
        const already = active.byPayment.get(payment.id) ?? 0;
        if (round2(already + again) > round2(Number(payment.amount)) + CENT) {
          throw new ConflictException(
            'Retrying this refund would refund more than the original payment took',
          );
        }
      }

      await manager.update(
        SaleReturnRefund,
        { tenantId, returnId, status: RefundStatus.FAILED },
        { status: RefundStatus.PENDING, failureReason: null },
      );
    });
    await this.processProviderRefunds(tenantId, returnId);
    await this.auditService.record({
      tenantId,
      action: 'return.refund_retried',
      entityType: 'return',
      entityId: returnId,
    });
    return this.findOne(tenantId, returnId);
  }

  async findAll(
    tenantId: string,
    query: ListReturnsQueryDto,
  ): Promise<PaginatedResult<SaleReturn>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const qb = this.returnRepository
      .createQueryBuilder('ret')
      .leftJoinAndSelect('ret.originalSale', 'sale')
      .where('ret.tenantId = :tenantId', { tenantId })
      .orderBy('ret.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.from) qb.andWhere('ret.createdAt >= :from', { from: query.from });
    if (query.to) qb.andWhere('ret.createdAt <= :to', { to: query.to });
    if (query.status)
      qb.andWhere('ret.status = :status', { status: query.status });
    if (query.saleId)
      qb.andWhere('ret.originalSaleId = :saleId', { saleId: query.saleId });
    if (query.returnType)
      qb.andWhere('ret.returnType = :returnType', {
        returnType: query.returnType,
      });
    if (query.search) {
      qb.andWhere(
        '(ret.returnNumber ILIKE :search OR sale.saleNumber ILIKE :search)',
        {
          search: containsPattern(query.search),
        },
      );
    }
    // Returns of the user's branches' sales (spec §9)
    const scope = branchFilterSql('sale');
    if (scope) qb.andWhere(scope.sql, scope.params);
    const [data, total] = await qb.getManyAndCount();
    return paginate(data, total, page, limit);
  }

  async findOne(tenantId: string, id: string): Promise<SaleReturn> {
    const saleReturn = await this.returnRepository
      .createQueryBuilder('ret')
      .leftJoinAndSelect('ret.items', 'items')
      .leftJoinAndSelect('ret.refunds', 'refunds')
      .leftJoinAndSelect('refunds.paymentMethod', 'paymentMethod')
      .leftJoinAndSelect('ret.originalSale', 'sale')
      .where('ret.id = :id AND ret.tenantId = :tenantId', { id, tenantId })
      .getOne();
    if (!saleReturn || !canAccessBranch(saleReturn.originalSale?.branchId)) {
      throw new NotFoundException('Return not found');
    }
    return saleReturn;
  }

  // ---------------------------------------------------------------------------

  /**
   * Returns after the store's return window need a manager's approval
   * (a different person with sales.refund). Returns the approver, if any.
   */
  private async checkReturnWindow(
    tenantId: string,
    user: AuthUser,
    sale: Sale,
    tokens: string[],
  ): Promise<string | null> {
    const { returnWindowDays } =
      await this.settingsService.getSettings(tenantId);
    const ageDays =
      (Date.now() - new Date(sale.saleDate).getTime()) / 86_400_000;
    if (ageDays <= returnWindowDays) return null;

    // Needed even with sales.refund: someone else must sign off
    const approverId = await this.verifyAny(tokens, 'sales.refund', user);
    if (!approverId) {
      // Same shape as a missing permission, so the frontend asks for a manager's approval
      throw approvalRequired(
        'sales.refund',
        `This sale is older than the ${returnWindowDays}-day return window. A manager must approve the return.`,
      );
    }
    return approverId;
  }

  /**
   * The user's own permission (returns null), or a manager's approval token for it
   * (returns the approver). Otherwise a 403 the frontend turns into an approval prompt.
   */
  private async authorize(
    user: AuthUser,
    permission: Permission,
    tokens: string[],
    message: string,
  ): Promise<string | null> {
    if (user.permissions?.includes(permission)) return null;
    const approverId = await this.verifyAny(tokens, permission, user);
    if (!approverId) throw approvalRequired(permission, message);
    return approverId;
  }

  private async verifyAny(
    tokens: string[],
    permission: Permission,
    user: AuthUser,
  ): Promise<string | null> {
    for (const token of tokens) {
      const approverId = await this.approvalsService.verify(
        token,
        permission,
        user,
      );
      if (approverId) return approverId;
    }
    return null;
  }

  /**
   * An earlier request with the same idempotency key: the same request gets the
   * original return back; a different one reusing the key is refused
   */
  private async replay(
    tenantId: string,
    returnId: string,
    dto: CreateReturnDto,
    options: ReturnCreateOptions = {},
  ): Promise<SaleReturn> {
    const saleReturn = await this.findOne(tenantId, returnId);
    if (!matchesReturnRequest(saleReturn, dto, !options.exchange)) {
      throw new ConflictException(
        'This idempotency key was already used for a different return',
      );
    }
    return saleReturn;
  }

  /**
   * Refunds that count against a sale: completed and pending ones (pending may still
   * go through). Failed refunds are left out — that money never reached the customer —
   * so a failed refund doesn't use up the refundable amount; it can be retried
   * (retryRefunds, checked against the same cap). Returned quantities are separate:
   * goods taken back stay counted whatever happened to the money.
   * Remaining refundable = sale total − (completed + pending refunds).
   */
  private async activeRefunds(
    manager: EntityManager,
    tenantId: string,
    saleId: string,
  ): Promise<{ total: number; byPayment: Map<string, number> }> {
    const rows = await manager
      .createQueryBuilder(SaleReturnRefund, 'refund')
      .innerJoin('refund.saleReturn', 'ret')
      .select('refund.originalPaymentId', 'paymentId')
      .addSelect('COALESCE(SUM(refund.amount), 0)', 'amount')
      .where('refund.tenantId = :tenantId', { tenantId })
      .andWhere('ret.originalSaleId = :saleId', { saleId })
      .andWhere('refund.status != :failed', { failed: RefundStatus.FAILED })
      .groupBy('refund.originalPaymentId')
      .getRawMany<{ paymentId: string | null; amount: string }>();
    const byPayment = new Map<string, number>();
    for (const row of rows) {
      if (row.paymentId) byPayment.set(row.paymentId, Number(row.amount));
    }
    return {
      total: round2(rows.reduce((a, r) => a + Number(r.amount), 0)),
      byPayment,
    };
  }

  /**
   * Decide how the refund is paid. Default: back to the original payments.
   * Explicit refunds may use any active method; a method used on the sale is linked
   * to that payment (card refunds then go through its provider).
   * `otherTender` lists what goes somewhere the sale wasn't paid from: a method not
   * used on the sale, or more than that method's payments have left to refund
   * (needs sales.refund.any_method).
   */
  private async planRefunds(
    manager: EntityManager,
    tenantId: string,
    sale: Sale,
    total: number,
    dto: CreateReturnDto,
    exchange?: ReturnCreateOptions['exchange'],
  ): Promise<{ refunds: PlannedRefund[]; otherTender: string[] }> {
    const payments = await manager.find(Payment, {
      where: { tenantId, saleId: sale.id, status: In(PAID_STATUSES) },
      relations: { paymentMethod: true },
    });
    const active = await this.activeRefunds(manager, tenantId, sale.id);

    // Cash actually kept on the sale is the cash tendered minus the change given
    let changeLeft = Number(sale.changeAmount ?? 0);
    const refundable: (RefundablePayment & {
      payment: Payment;
      special: SpecialTenderCode | null;
    })[] = payments.map((payment) => {
      const isCash =
        payment.paymentMethod?.methodType === PaymentMethodType.CASH;
      let amount = Number(payment.amount);
      if (isCash && changeLeft > 0) {
        const taken = Math.min(changeLeft, amount);
        amount = round2(amount - taken);
        changeLeft = round2(changeLeft - taken);
      }
      return {
        payment,
        paymentId: payment.id,
        paymentMethodId: payment.paymentMethodId,
        isCash,
        amount,
        refunded: active.byPayment.get(payment.id) ?? 0,
        special: specialTenderOf(payment.paymentMethod),
      };
    });

    // Never refund more than was paid on the sale in total (failed refunds excluded,
    // see activeRefunds)
    const alreadyRefunded = round2(
      refundable.reduce((a, p) => a + p.refunded, 0),
    );
    if (round2(active.total + total) > round2(Number(sale.total)) + CENT) {
      throw new BadRequestException(
        'This refund would exceed what the customer paid for the sale',
      );
    }

    const plan = (
      paymentMethodId: string,
      amount: number,
      source: (typeof refundable)[number] | null,
      method: PaymentMethod | null,
    ): PlannedRefund => {
      const special = source?.special ?? specialTenderOf(method);
      return {
        paymentMethodId,
        amount: round2(amount),
        isCash: special
          ? false
          : source
            ? source.isCash
            : method?.methodType === PaymentMethodType.CASH,
        originalPaymentId: source?.paymentId ?? null,
        // Account, stored value and exchange credit move no money at a provider
        provider: special ? null : (source?.payment.provider ?? null),
        providerReference: special
          ? null
          : (source?.payment.providerReference ?? null),
        special,
        storedValueAccountId:
          (source?.payment.metadata?.storedValueAccountId as
            string | undefined) ?? null,
      };
    };

    const refunds: PlannedRefund[] = [];
    let toPlan = total;
    // Exchange: the returned value pays for the replacement sale (up to its total);
    // only what is left over is refunded
    if (exchange) {
      const credit = Math.min(cents(total), cents(exchange.newSaleTotal)) / 100;
      if (credit > 0) {
        const method = await ensureSpecialMethod(
          manager,
          tenantId,
          EXCHANGE_CREDIT_CODE,
        );
        refunds.push(plan(method.id, credit, null, method));
      }
      toPlan = round2(total - credit);
    }
    if (toPlan <= 0) return { refunds, otherTender: [] };

    // Store credit: the customer keeps the money in the store (no approval needed)
    if (dto.refundToStoreCredit) {
      const method = await ensureSpecialMethod(
        manager,
        tenantId,
        STORE_CREDIT_CODE,
      );
      refunds.push(plan(method.id, toPlan, null, method));
      return { refunds, otherTender: [] };
    }

    const requestedRefunds =
      !exchange && (dto.refunds?.length || !dto.refundMethodId)
        ? dto.refunds
        : dto.refundMethodId
          ? [{ paymentMethodId: dto.refundMethodId, amount: toPlan }]
          : undefined;

    if (!requestedRefunds?.length) {
      // Default: a sale (partly) on account gets a credit note for its share of the
      // return, the rest goes back to the original tenders (card first, then cash)
      const onAccount = refundable.filter((p) => p.special === ON_ACCOUNT_CODE);
      const ordinary = refundable.filter(
        (p) =>
          p.special !== ON_ACCOUNT_CODE && p.special !== EXCHANGE_CREDIT_CODE,
      );
      let remaining = cents(toPlan);
      if (onAccount.length) {
        const paid = onAccount.reduce((a, p) => a + cents(p.amount), 0);
        const credited = onAccount.reduce((a, p) => a + cents(p.refunded), 0);
        const room = paid - credited;
        const share = onAccountShare({
          saleTotal: Number(sale.total),
          paidOnAccount: paid / 100,
          creditedSoFar: credited / 100,
          refundedSoFar: active.total,
          refund: toPlan,
        });
        // What the other tenders can't cover also comes off the account
        const otherRoom = ordinary.reduce(
          (a, p) => a + Math.max(0, cents(p.amount) - cents(p.refunded)),
          0,
        );
        let part = Math.max(cents(share), remaining - otherRoom);
        part = Math.max(0, Math.min(part, room, remaining));
        for (const payment of onAccount) {
          if (part <= 0) break;
          const left = cents(payment.amount) - cents(payment.refunded);
          const amount = Math.min(left, part);
          if (amount <= 0) continue;
          refunds.push(
            plan(payment.paymentMethodId, amount / 100, payment, null),
          );
          part -= amount;
          remaining -= amount;
        }
      }
      if (remaining > 0) {
        try {
          for (const allocation of allocateToOriginalTenders(
            remaining / 100,
            ordinary,
          )) {
            refunds.push(
              plan(
                allocation.paymentMethodId,
                allocation.amount,
                ordinary.find((p) => p.paymentId === allocation.paymentId)!,
                null,
              ),
            );
          }
        } catch {
          throw new BadRequestException(
            `The original payments can't cover this refund (${alreadyRefunded.toFixed(2)} already refunded). Choose how to refund it.`,
          );
        }
      }
      return { refunds, otherTender: [] };
    }

    const requested = round2(
      requestedRefunds.reduce((a, r) => a + r.amount, 0),
    );
    if (requested !== round2(toPlan)) {
      throw new BadRequestException(
        `Refunds (${requested.toFixed(2)}) must equal the return total (${toPlan.toFixed(2)})`,
      );
    }
    const methods = await manager.find(PaymentMethod, {
      where: {
        tenantId,
        id: In(requestedRefunds.map((r) => r.paymentMethodId)),
      },
    });
    // What each method used on the sale still has left to refund
    const room = new Map<string, number>();
    for (const p of refundable) {
      room.set(
        p.paymentMethodId,
        round2((room.get(p.paymentMethodId) ?? 0) + p.amount - p.refunded),
      );
    }
    const requestedPerMethod = new Map<string, number>();
    const otherTender: string[] = [];
    for (const refund of requestedRefunds) {
      const method = methods.find((m) => m.id === refund.paymentMethodId);
      if (!method || method.status !== PaymentMethodStatus.ACTIVE) {
        throw new BadRequestException(
          'Refund payment method not found or inactive',
        );
      }
      const special = specialTenderOf(method);
      const name = method.name?.en ?? method.code;
      if (special === EXCHANGE_CREDIT_CODE) {
        throw new BadRequestException(
          'Exchange credit is only given by an exchange',
        );
      }
      const soFar = round2(
        (requestedPerMethod.get(method.id) ?? 0) + refund.amount,
      );
      requestedPerMethod.set(method.id, soFar);
      // Store credit keeps the money in the store: never an "other tender"
      if (special !== STORE_CREDIT_CODE) {
        if (!room.has(method.id)) {
          otherTender.push(`${name} was not used on this sale`);
        } else if (soFar > (room.get(method.id) ?? 0) + CENT) {
          otherTender.push(
            `${name}: ${soFar.toFixed(2)} is more than the ${(room.get(method.id) ?? 0).toFixed(2)} left to refund on it`,
          );
        }
      }
      // Link to an original payment of the same method that still has room
      const source =
        refundable.find(
          (p) =>
            p.paymentMethodId === method.id &&
            round2(p.amount - p.refunded) >= refund.amount,
        ) ?? null;
      if (!source && special === GIFT_CARD_CODE) {
        throw new BadRequestException(
          'Gift card refunds go back to a gift card used on this sale: refund to store credit instead',
        );
      }
      if (
        !source &&
        !special &&
        method.methodType !== PaymentMethodType.CASH &&
        method.provider &&
        method.provider !== 'manual'
      ) {
        throw new BadRequestException(
          `${method.name?.en ?? method.code} refunds must go back to a ${method.name?.en ?? method.code} payment from this sale`,
        );
      }
      refunds.push(plan(method.id, refund.amount, source, method));
    }
    return { refunds, otherTender };
  }

  /**
   * Refunds that move no money: a credit note on the customer's account, a credit
   * to store credit, or value put back on the gift card that paid
   */
  private async postSpecialRefunds(
    manager: EntityManager,
    input: {
      tenantId: string;
      sale: Sale;
      returnId: string;
      returnNumber: string;
      refunds: PlannedRefund[];
      customerId: string | null;
    },
  ) {
    const { tenantId, sale } = input;
    for (const refund of input.refunds) {
      if (refund.special === ON_ACCOUNT_CODE) {
        if (!sale.customerId) {
          throw new BadRequestException(
            'Only a sale with a customer can be credited to an account',
          );
        }
        await this.customerCredit.creditNote(manager, {
          tenantId,
          customerId: sale.customerId,
          saleId: sale.id,
          returnId: input.returnId,
          amount: refund.amount,
          note: `Return ${input.returnNumber}`,
        });
      } else if (refund.special === STORE_CREDIT_CODE) {
        const customerId = refund.storedValueAccountId
          ? null
          : (sale.customerId ?? input.customerId);
        let accountId = refund.storedValueAccountId;
        if (!accountId) {
          if (!customerId) {
            throw new BadRequestException(
              'Choose the customer who receives the store credit',
            );
          }
          const known = await manager.exists(Customer, {
            where: { id: customerId, tenantId },
          });
          if (!known) throw new NotFoundException('Customer not found');
          accountId = (
            await this.storedValue.storeCreditAccount(
              manager,
              tenantId,
              customerId,
              sale.currencyCode,
            )
          ).id;
        }
        await this.storedValue.refundTo(manager, {
          tenantId,
          accountId,
          amount: refund.amount,
          saleId: sale.id,
          returnId: input.returnId,
          note: `Return ${input.returnNumber}`,
        });
      } else if (refund.special === GIFT_CARD_CODE) {
        if (!refund.storedValueAccountId) {
          throw new BadRequestException(
            'The gift card that paid for this sale is not known',
          );
        }
        await this.storedValue.refundTo(manager, {
          tenantId,
          accountId: refund.storedValueAccountId,
          amount: refund.amount,
          saleId: sale.id,
          returnId: input.returnId,
          note: `Return ${input.returnNumber}`,
        });
      }
    }
  }

  private async processProviderRefunds(tenantId: string, returnId: string) {
    const repo = this.dataSource.getRepository(SaleReturnRefund);
    const pending = await repo.find({
      where: { tenantId, returnId, status: RefundStatus.PENDING },
    });
    for (const refund of pending) {
      if (!refund.provider || !this.providers.has(refund.provider)) {
        await repo.update(refund.id, {
          status: RefundStatus.FAILED,
          failureReason: `Payment provider ${refund.provider ?? '(none)'} is not available`,
        });
        continue;
      }
      try {
        const result = await this.providers
          .get(refund.provider)
          .refund(
            refund.providerReference ?? '',
            Number(refund.amount),
            refund.idempotencyKey,
          );
        const status =
          result.status === 'refunded'
            ? RefundStatus.COMPLETED
            : result.status === 'failed' || result.status === 'cancelled'
              ? RefundStatus.FAILED
              : RefundStatus.PENDING;
        await repo.update(refund.id, {
          status,
          failureReason:
            status === RefundStatus.FAILED
              ? (result.failureReason ?? 'Refund declined')
              : null,
        });
      } catch (error) {
        this.logger.warn(
          `Refund ${refund.id} failed: ${(error as Error).message}`,
        );
        // Timeouts stay pending (outcome unknown; the idempotency key makes a retry safe)
        await repo.update(refund.id, {
          failureReason: (error as Error).message,
        });
      }
    }

    const all = await repo.find({ where: { tenantId, returnId } });
    const status = all.some((r) => r.status === RefundStatus.FAILED)
      ? ReturnStatus.REFUND_FAILED
      : all.some((r) => r.status === RefundStatus.PENDING)
        ? ReturnStatus.REFUND_PENDING
        : ReturnStatus.COMPLETED;
    await this.returnRepository.update({ id: returnId, tenantId }, { status });
  }

  // Units already returned per sale line
  private async returnedQuantities(manager: EntityManager, saleId: string) {
    const rows = await manager
      .createQueryBuilder(SaleReturnItem, 'item')
      .innerJoin('item.saleReturn', 'ret')
      .select('item.saleItemId', 'saleItemId')
      .addSelect('SUM(item.quantity)', 'quantity')
      .where('ret.originalSaleId = :saleId', { saleId })
      .groupBy('item.saleItemId')
      .getRawMany<{ saleItemId: string; quantity: string }>();
    return new Map(rows.map((r) => [r.saleItemId, Number(r.quantity)]));
  }

  private async isFullyReturned(
    manager: EntityManager,
    saleId: string,
  ): Promise<boolean> {
    const [row] = await manager.query<{ remaining: string }[]>(
      `SELECT COALESCE(SUM(si.quantity), 0) - COALESCE((
         SELECT SUM(ri.quantity) FROM sale_return_items ri
         JOIN sale_returns r ON r.id = ri."returnId"
         WHERE r."originalSaleId" = $1), 0) AS remaining
       FROM sale_items si WHERE si."saleId" = $1`,
      [saleId],
    );
    return Number(row?.remaining ?? 0) <= 0;
  }
}

/**
 * Unit of a sold line, from its snapshot: measured lines (unitPrecision stored at
 * sale time) take decimals; others whole units, unless the line itself was sold
 * with decimals.
 */
export function lineUnit(item: {
  quantity: number;
  metadata?: Record<string, unknown> | null;
}): QuantityUnit {
  const precision = item.metadata?.unitPrecision;
  if (typeof precision === 'number' && precision > 0) {
    return {
      code: (item.metadata?.unit as string | undefined) ?? null,
      allowsDecimals: true,
      precision,
    };
  }
  return Number.isInteger(Number(item.quantity))
    ? { code: null, allowsDecimals: false, precision: 0 }
    : { code: null, allowsDecimals: true, precision: 4 };
}
