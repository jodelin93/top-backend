import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  CustomerOrder,
  CustomerOrderStatus,
  DepositOutcome,
} from '../database/entities/customer-order.entity';
import { CustomerOrderItem } from '../database/entities/customer-order-item.entity';
import {
  CustomerOrderPayment,
  CustomerOrderPaymentType,
} from '../database/entities/customer-order-payment.entity';
import {
  PaymentMethod,
  PaymentMethodStatus,
  PaymentMethodType,
} from '../database/entities/payment-method.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { Register } from '../database/entities/register.entity';
import { Branch } from '../database/entities/branch.entity';
import { CashMovementType } from '../database/entities/cash-movement.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { assertRegisterAccess, scopedBranchIds } from '../auth/branch-scope';
import { requestContext } from '../common/context/request-context';
import { SalesService } from '../sales/sales.service';
import { ShiftsService } from '../shifts/shifts.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { specialTenderOf } from '../sales/special-tenders';
import { LOYALTY_METHOD_CODE } from '../loyalty/loyalty.service';
import { round2 } from '../sales/sale-calculator';
import { exchangeRate, toSaleCurrency } from '../currency/currency-math';
import {
  branchDocumentPrefix,
  nextDocumentNumber,
} from '../common/utils/sequence';
import {
  assertNotPastDay,
  storeTimezone,
} from '../common/validation/date-rules';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { paginate } from '../common/dto/pagination.dto';
import { containsPattern } from '../common/utils/like';
import {
  ACTIVE_ORDER_STATUSES,
  assertOrderActive,
  assertOrderTransition,
  balanceDue,
  depositError,
} from './order-rules';
import { findVisibleOrder } from './order-sale';
import {
  AddDepositDto,
  CancelOrderDto,
  CreateOrderDto,
  ListOrdersQueryDto,
  OrderPaymentInput,
  QuoteOrderDto,
  SetOrderStatusDto,
  UpdateOrderDto,
} from './orders.dto';

// How a customer can pay a deposit (or get it back): money that really moves
const PAYABLE_TYPES: readonly PaymentMethodType[] = [
  PaymentMethodType.CASH,
  PaymentMethodType.CARD,
  PaymentMethodType.MOBILE,
  PaymentMethodType.BANK_TRANSFER,
  PaymentMethodType.CHECK,
  PaymentMethodType.OTHER,
];

interface ValidatedOrderPayment {
  method: PaymentMethod;
  isCash: boolean;
  // In the order currency
  amount: number;
  reference: string | null;
  tendered: { currencyCode: string; amount: number; rate: number } | null;
}

const PERSON = (alias: string) =>
  `COALESCE(NULLIF(CONCAT_WS(' ', ${alias}."firstName", ${alias}."lastName"), ''), ${alias}.email)`;

/**
 * Orders with a deposit (see CustomerOrder): taken at the till for services
 * (items not tracked in stock), priced exactly like a sale, the deposit going
 * into the session that took it. Picked up through POST /sales with orderId.
 */
@Injectable()
export class OrdersService {
  constructor(
    private dataSource: DataSource,
    private salesService: SalesService,
    private shiftsService: ShiftsService,
    private settingsService: SettingsService,
    private auditService: AuditService,
  ) {}

  /** Price an order's cart like the till (and collect the approvals it needs) */
  async quote(
    tenantId: string,
    user: AuthUser,
    dto: QuoteOrderDto,
    approvalToken?: string,
  ) {
    await this.assertServices(tenantId, dto.items);
    return this.salesService.quote(
      tenantId,
      user,
      this.saleInput(dto),
      approvalToken,
    );
  }

  async create(
    tenantId: string,
    user: AuthUser,
    dto: CreateOrderDto,
    approvalToken?: string,
  ) {
    if (dto.idempotencyKey) {
      const existing = await this.dataSource
        .getRepository(CustomerOrder)
        .findOne({ where: { tenantId, idempotencyKey: dto.idempotencyKey } });
      if (existing) return this.replayCreate(existing, dto);
    }
    await this.assertServices(tenantId, dto.items);
    // Prices, taxes, discounts and their approvals: the till's own rules
    const quote = await this.salesService.quote(
      tenantId,
      user,
      this.saleInput(dto),
      approvalToken,
    );
    const register = await this.dataSource
      .getRepository(Register)
      .findOneOrFail({ where: { id: dto.registerId, tenantId } });
    const branch = await this.dataSource
      .getRepository(Branch)
      .findOneOrFail({ where: { id: register.branchId, tenantId } });
    const timezone = await storeTimezone(
      this.dataSource.manager,
      tenantId,
      branch.id,
    );
    const readyBy = dto.readyBy?.slice(0, 10) ?? null;
    assertNotPastDay(readyBy, timezone, 'The ready date is in the past');
    const deposit = dto.deposit
      ? await this.validatePayment(tenantId, dto.deposit, quote.currencyCode)
      : null;
    if (deposit) {
      const error = depositError(
        { total: quote.total, paidAmount: 0 },
        deposit.amount,
      );
      if (error) throw new BadRequestException(error);
    }

    try {
      const orderId = await this.dataSource.transaction(async (manager) => {
        const orderNumber = await nextDocumentNumber(manager, {
          table: 'customer_orders',
          column: 'orderNumber',
          tenantId,
          prefix: `${branchDocumentPrefix(branch.code)}-CMD`,
        });
        const order = await manager.save(
          manager.create(CustomerOrder, {
            tenantId,
            orderNumber,
            branchId: branch.id,
            registerId: register.id,
            customerId: dto.customerId,
            userId: user.id,
            status: CustomerOrderStatus.OPEN,
            readyBy,
            subtotal: quote.subtotal,
            discountAmount: quote.discountAmount,
            taxAmount: quote.taxAmount,
            total: quote.total,
            paidAmount: 0,
            currencyCode: quote.currencyCode,
            cartDiscount: dto.cartDiscount
              ? { type: dto.cartDiscount.type, value: dto.cartDiscount.value }
              : null,
            groupDiscountPercent: quote.groupDiscount?.percent ?? 0,
            notes: dto.notes?.trim() || null,
            idempotencyKey: dto.idempotencyKey ?? null,
          }),
        );
        // Quote lines follow the cart's order (no gift cards on an order)
        await manager.save(
          quote.lines.map((line, index) =>
            manager.create(CustomerOrderItem, {
              tenantId,
              orderId: order.id,
              variantId: line.variantId,
              sku: line.sku,
              productName: line.productName,
              variantName: line.variantName,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              catalogPrice: line.catalogPrice,
              discountPercent: dto.items[index]?.discountPercent ?? 0,
              subtotal: line.subtotal,
              discountAmount: line.discountAmount,
              taxRate: line.taxRate,
              taxAmount: line.taxAmount,
              total: line.total,
              note: dto.items[index]?.note?.trim() || null,
              lineNumber: index + 1,
            }),
          ),
        );
        await this.auditService.record(
          {
            tenantId,
            action: 'order.created',
            entityType: 'customer_order',
            entityId: order.id,
            metadata: {
              orderNumber,
              customerId: dto.customerId,
              total: quote.total,
              deposit: deposit?.amount ?? 0,
              overrides: quote.overrides,
            },
          },
          manager,
        );
        if (deposit) {
          await this.postPayment(manager, order, user, {
            type: CustomerOrderPaymentType.DEPOSIT,
            payment: deposit,
            registerId: register.id,
          });
        }
        return order.id;
      });
      return this.findOne(tenantId, orderId);
    } catch (error) {
      // Two submissions with the same key raced: return the one that won
      if (
        dto.idempotencyKey &&
        isPgError(error, PG_UNIQUE_VIOLATION, 'uq_customer_order_idempotency')
      ) {
        const winner = await this.dataSource
          .getRepository(CustomerOrder)
          .findOneOrFail({
            where: { tenantId, idempotencyKey: dto.idempotencyKey },
          });
        return this.replayCreate(winner, dto);
      }
      throw error;
    }
  }

  /** Another deposit on an order still waiting for its customer */
  async addDeposit(
    tenantId: string,
    user: AuthUser,
    id: string,
    dto: AddDepositDto,
  ) {
    if (dto.idempotencyKey) {
      const existing = await this.dataSource
        .getRepository(CustomerOrderPayment)
        .findOne({ where: { tenantId, idempotencyKey: dto.idempotencyKey } });
      if (existing) return this.replayDeposit(existing, id, dto);
    }
    const order = await findVisibleOrder(this.dataSource.manager, tenantId, id);
    const payment = await this.validatePayment(
      tenantId,
      dto,
      order.currencyCode,
    );
    try {
      await this.dataSource.transaction(async (manager) => {
        const locked = await findVisibleOrder(manager, tenantId, id, {
          lock: true,
        });
        assertOrderActive(locked);
        const error = depositError(locked, payment.amount);
        if (error) throw new BadRequestException(error);
        await this.postPayment(manager, locked, user, {
          type: CustomerOrderPaymentType.DEPOSIT,
          payment,
          registerId: dto.registerId,
          idempotencyKey: dto.idempotencyKey,
        });
      });
    } catch (error) {
      if (
        dto.idempotencyKey &&
        isPgError(
          error,
          PG_UNIQUE_VIOLATION,
          'uq_customer_order_payment_idempotency',
        )
      ) {
        const winner = await this.dataSource
          .getRepository(CustomerOrderPayment)
          .findOneOrFail({
            where: { tenantId, idempotencyKey: dto.idempotencyKey },
          });
        return this.replayDeposit(winner, id, dto);
      }
      throw error;
    }
    return this.findOne(tenantId, id);
  }

  /** Ready for the customer, or back in preparation */
  async setStatus(
    tenantId: string,
    user: AuthUser,
    id: string,
    dto: SetOrderStatusDto,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const order = await findVisibleOrder(manager, tenantId, id, {
        lock: true,
      });
      if (order.status === dto.status) return;
      assertOrderTransition(order, dto.status);
      const ready = dto.status === CustomerOrderStatus.READY;
      await manager.update(
        CustomerOrder,
        { id, tenantId },
        {
          status: dto.status,
          readyAt: ready ? new Date() : null,
          readyById: ready ? user.id : null,
        },
      );
      await this.auditService.record(
        {
          tenantId,
          action: ready ? 'order.ready' : 'order.reopened',
          entityType: 'customer_order',
          entityId: id,
          metadata: { orderNumber: order.orderNumber },
        },
        manager,
      );
    });
    return this.findOne(tenantId, id);
  }

  /** The ready date and the notes, while the order waits for its customer */
  async update(tenantId: string, id: string, dto: UpdateOrderDto) {
    await this.dataSource.transaction(async (manager) => {
      const order = await findVisibleOrder(manager, tenantId, id, {
        lock: true,
      });
      assertOrderActive(order);
      const changes: Partial<CustomerOrder> = {};
      if (dto.readyBy !== undefined) {
        const readyBy = dto.readyBy?.slice(0, 10) || null;
        if (readyBy !== order.readyBy) {
          assertNotPastDay(
            readyBy,
            await storeTimezone(manager, tenantId, order.branchId),
            'The ready date is in the past',
          );
        }
        changes.readyBy = readyBy;
      }
      if (dto.notes !== undefined) changes.notes = dto.notes?.trim() || null;
      if (Object.keys(changes).length) {
        await manager.update(CustomerOrder, { id, tenantId }, changes);
      }
    });
    return this.findOne(tenantId, id);
  }

  /**
   * Cancel an order (orders.cancel, or a manager's approval). Its deposits are
   * given back (cash out of the till's open session) or kept by the store, as
   * the manager decides; a reason is always recorded.
   */
  async cancel(
    tenantId: string,
    user: AuthUser,
    id: string,
    dto: CancelOrderDto,
  ) {
    const approverId = requestContext.get()?.approverId ?? null;
    const current = await findVisibleOrder(
      this.dataSource.manager,
      tenantId,
      id,
    );
    const refunding =
      dto.deposits === 'refund' && Number(current.paidAmount) > 0;
    if (refunding && !dto.refundMethodId) {
      throw new BadRequestException(
        'Choose how the deposits are given back to the customer',
      );
    }
    const method = refunding
      ? await this.validateMethod(tenantId, dto.refundMethodId!, dto.reference)
      : null;

    await this.dataSource.transaction(async (manager) => {
      const order = await findVisibleOrder(manager, tenantId, id, {
        lock: true,
      });
      assertOrderTransition(order, CustomerOrderStatus.CANCELLED);
      const paid = round2(Number(order.paidAmount));
      let outcome: DepositOutcome = 'none';
      if (paid > 0 && dto.deposits === 'refund') {
        await this.postPayment(manager, order, user, {
          type: CustomerOrderPaymentType.REFUND,
          payment: {
            method: method!,
            isCash: method!.methodType === PaymentMethodType.CASH,
            amount: paid,
            reference: dto.reference?.trim() || null,
            tendered: null,
          },
          registerId: dto.registerId,
          approverId,
          note: dto.reason.trim(),
        });
        outcome = 'refunded';
      } else if (paid > 0) {
        outcome = 'kept';
      }
      await manager.update(
        CustomerOrder,
        { id, tenantId },
        {
          status: CustomerOrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelledById: user.id,
          cancelApproverId: approverId,
          cancelReason: dto.reason.trim(),
          depositOutcome: outcome,
        },
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'order.cancelled',
          entityType: 'customer_order',
          entityId: id,
          reason: dto.reason.trim(),
          metadata: {
            orderNumber: order.orderNumber,
            deposits: paid,
            outcome,
            approverId,
          },
        },
        manager,
      );
    });
    return this.findOne(tenantId, id);
  }

  async findAll(tenantId: string, query: ListOrdersQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const qb = this.dataSource
      .getRepository(CustomerOrder)
      .createQueryBuilder('o')
      .leftJoinAndSelect('o.customer', 'customer')
      .where('o.tenantId = :tenantId', { tenantId })
      .orderBy('o.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    // Branch staff see their branches' orders only
    const scope = scopedBranchIds();
    if (scope) qb.andWhere('o.branchId = ANY(:scope)', { scope });
    if (query.branchId) {
      qb.andWhere('o.branchId = :branchId', { branchId: query.branchId });
    }
    if (query.customerId) {
      qb.andWhere('o.customerId = :customerId', {
        customerId: query.customerId,
      });
    }
    if (query.status === 'active') {
      qb.andWhere('o.status IN (:...active)', {
        active: ACTIVE_ORDER_STATUSES,
      });
    } else if (query.status) {
      qb.andWhere('o.status = :status', { status: query.status });
    }
    if (query.search?.trim()) {
      qb.andWhere(
        `(o.orderNumber ILIKE :search OR customer.code ILIKE :search OR customer.phone ILIKE :search
          OR CONCAT_WS(' ', customer.firstName, customer.lastName) ILIKE :search
          OR customer.companyName ILIKE :search)`,
        { search: containsPattern(query.search) },
      );
    }
    const [rows, total] = await qb.getManyAndCount();
    const branches = await this.names(
      'branches',
      'name',
      rows.map((o) => o.branchId),
    );
    return paginate(
      rows.map((order) => ({
        ...order,
        balanceDue: balanceDue(order),
        branch: { id: order.branchId, name: branches.get(order.branchId) },
      })),
      total,
      page,
      limit,
    );
  }

  /** An order with its lines, deposits and what the receipt needs */
  async findOne(tenantId: string, id: string) {
    const manager = this.dataSource.manager;
    const order = await findVisibleOrder(manager, tenantId, id);
    const full = await manager.findOneOrFail(CustomerOrder, {
      where: { id: order.id, tenantId },
      relations: {
        customer: true,
        items: true,
        payments: { paymentMethod: true },
      },
    });
    full.items.sort((a, b) => a.lineNumber - b.lineNumber);
    full.payments.sort(
      (a, b) =>
        new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
    const branch = await manager.getRepository(Branch).findOne({
      where: { id: full.branchId, tenantId },
    });
    const register = await manager.getRepository(Register).findOne({
      where: { id: full.registerId, tenantId },
      select: { id: true, name: true },
    });
    const userIds = [
      full.userId,
      full.readyById,
      full.cancelledById,
      full.cancelApproverId,
      ...full.payments.map((p) => p.userId),
    ].filter((v): v is string => !!v);
    const people = await this.people(userIds);
    const sale = full.saleId
      ? await manager.query<{ saleNumber: string }[]>(
          `SELECT "saleNumber" FROM sales WHERE id = $1 AND "tenantId" = $2`,
          [full.saleId, tenantId],
        )
      : [];
    return {
      ...full,
      balanceDue: balanceDue(full),
      branch,
      register,
      user: people.get(full.userId) ?? null,
      readyByName: full.readyById
        ? (people.get(full.readyById)?.name ?? null)
        : null,
      cancelledByName: full.cancelledById
        ? (people.get(full.cancelledById)?.name ?? null)
        : null,
      cancelApproverName: full.cancelApproverId
        ? (people.get(full.cancelApproverId)?.name ?? null)
        : null,
      saleNumber: sale[0]?.saleNumber ?? null,
      payments: full.payments.map((p) => ({
        ...p,
        userName: people.get(p.userId)?.name ?? null,
      })),
    };
  }

  // ---------------------------------------------------------------------------

  private saleInput(dto: QuoteOrderDto) {
    return {
      registerId: dto.registerId,
      customerId: dto.customerId,
      priceListId: dto.priceListId,
      cartDiscount: dto.cartDiscount,
      items: dto.items,
    };
  }

  /** Orders are for services: every item must be one not tracked in stock */
  private async assertServices(
    tenantId: string,
    items: { variantId: string }[],
  ) {
    const ids = [...new Set(items.map((i) => i.variantId))];
    const variants = await this.dataSource.getRepository(ProductVariant).find({
      where: { tenantId, id: In(ids) },
      relations: { product: true },
    });
    const tracked = variants.find((v) => v.product?.isStockTracked !== false);
    if (tracked) {
      throw new BadRequestException(
        `${tracked.product?.name?.en ?? tracked.sku} is tracked in stock: orders are for services (items not tracked in stock). Sell it in a normal sale.`,
      );
    }
  }

  /** A payment method money can move with, and the reference it needs */
  private async validateMethod(
    tenantId: string,
    paymentMethodId: string,
    reference?: string,
  ): Promise<PaymentMethod> {
    const method = await this.dataSource
      .getRepository(PaymentMethod)
      .findOne({ where: { id: paymentMethodId, tenantId } });
    if (
      !method ||
      method.status !== PaymentMethodStatus.ACTIVE ||
      !PAYABLE_TYPES.includes(method.methodType) ||
      specialTenderOf(method) ||
      method.code === LOYALTY_METHOD_CODE
    ) {
      throw new BadRequestException(
        'Choose how the customer paid (cash, card, mobile money, transfer...)',
      );
    }
    // A payment terminal confirms its own payments: deposits are confirmed by hand
    if (
      method.methodType !== PaymentMethodType.CASH &&
      method.provider &&
      method.provider !== 'manual'
    ) {
      throw new BadRequestException(
        `${method.name?.en ?? method.code} goes through a payment terminal: take deposits in cash or with a manually confirmed payment`,
      );
    }
    if (method.requiresReference && !reference?.trim()) {
      throw new BadRequestException(
        `${method.name?.en ?? method.code} payments need a reference`,
      );
    }
    return method;
  }

  /** The method, and the amount in the order currency (paid in another: at the store's rate) */
  private async validatePayment(
    tenantId: string,
    input: OrderPaymentInput,
    orderCurrency: string,
  ): Promise<ValidatedOrderPayment> {
    const method = await this.validateMethod(
      tenantId,
      input.paymentMethodId,
      input.reference,
    );
    let amount = round2(input.amount);
    let tendered: ValidatedOrderPayment['tendered'] = null;
    const code = input.currencyCode?.toUpperCase();
    if (code && code !== orderCurrency) {
      const settings = await this.settingsService.getSettings(tenantId);
      const rate = exchangeRate(
        settings.exchangeRates,
        settings.currencyCode,
        orderCurrency,
        code,
      );
      if (!rate) {
        throw new BadRequestException(`${code} is not accepted by this store`);
      }
      if (!input.tenderedAmount) {
        throw new BadRequestException(
          `Give the amount paid in ${code} (tenderedAmount)`,
        );
      }
      tendered = {
        currencyCode: code,
        amount: round2(input.tenderedAmount),
        rate,
      };
      amount = round2(toSaleCurrency(tendered.amount, rate));
    }
    return {
      method,
      isCash: method.methodType === PaymentMethodType.CASH,
      amount,
      reference: input.reference?.trim() || null,
      tendered,
    };
  }

  /**
   * Record a deposit or a refund on a locked order and move its projection.
   * Cash goes into (comes out of) the user's own or a shared open session on
   * the register; other methods are filed under that session when there is one.
   */
  private async postPayment(
    manager: EntityManager,
    order: CustomerOrder,
    user: AuthUser,
    input: {
      type: CustomerOrderPaymentType;
      payment: ValidatedOrderPayment;
      registerId?: string | null;
      idempotencyKey?: string | null;
      approverId?: string | null;
      note?: string | null;
    },
  ) {
    const { payment } = input;
    const deposit = input.type === CustomerOrderPaymentType.DEPOSIT;
    if (payment.isCash && !input.registerId) {
      throw new BadRequestException('Choose the register the cash goes into');
    }
    if (input.registerId) {
      await assertRegisterAccess(
        manager,
        order.tenantId,
        input.registerId,
        'Register not found',
      );
    }
    let shift = input.registerId
      ? await this.shiftsService.getOpenShift(
          order.tenantId,
          input.registerId,
          manager,
        )
      : null;
    // Never into another cashier's drawer (getOpenShift falls back to any open shift)
    if (shift && shift.openedById !== user.id && !shift.shared) shift = null;
    if (payment.isCash && !shift) {
      throw new ConflictException(
        deposit
          ? 'Open your cash session on this register to take a cash deposit'
          : 'Open your cash session on this register to give the cash back',
      );
    }
    const saved = await manager.save(
      manager.create(CustomerOrderPayment, {
        tenantId: order.tenantId,
        orderId: order.id,
        type: input.type,
        amount: payment.amount,
        paymentMethodId: payment.method.id,
        reference: payment.reference,
        tenderedCurrency: payment.tendered?.currencyCode ?? null,
        tenderedAmount: payment.tendered?.amount ?? null,
        exchangeRate: payment.tendered?.rate ?? null,
        shiftId: shift?.id ?? null,
        registerId: input.registerId ?? null,
        userId: user.id,
        approverId: input.approverId ?? null,
        note: input.note ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
      }),
    );
    const paidAmount = round2(
      Number(order.paidAmount) + (deposit ? payment.amount : -payment.amount),
    );
    if (paidAmount < 0) {
      throw new BadRequestException('More than the deposits paid');
    }
    await manager.update(
      CustomerOrder,
      { id: order.id, tenantId: order.tenantId },
      { paidAmount },
    );
    order.paidAmount = paidAmount;
    if (payment.isCash && shift) {
      await this.shiftsService.recordCashMovement(manager, {
        tenantId: order.tenantId,
        shiftId: shift.id,
        type: deposit ? CashMovementType.PAID_IN : CashMovementType.REFUND,
        // Cash paid in another currency goes into that currency's cash
        amount: payment.tendered?.amount ?? payment.amount,
        currencyCode: payment.tendered?.currencyCode ?? null,
        userId: user.id,
        approverId: input.approverId ?? null,
        reason: deposit
          ? `Deposit on order ${order.orderNumber}`
          : `Deposit refunded, order ${order.orderNumber}`,
        reference: order.orderNumber,
        sourceType: deposit ? 'order_deposit' : 'order_refund',
        sourceId: saved.id,
      });
    }
    if (deposit) {
      await this.auditService.record(
        {
          tenantId: order.tenantId,
          action: 'order.deposit',
          entityType: 'customer_order',
          entityId: order.id,
          metadata: {
            orderNumber: order.orderNumber,
            amount: payment.amount,
            method: payment.method.code,
            paidAmount,
            shiftId: shift?.id ?? null,
          },
        },
        manager,
      );
    }
    return saved;
  }

  private async replayCreate(order: CustomerOrder, dto: CreateOrderDto) {
    if (order.customerId !== dto.customerId) {
      throw new ConflictException(
        'This idempotency key was already used for another order',
      );
    }
    return this.findOne(order.tenantId, order.id);
  }

  private async replayDeposit(
    payment: CustomerOrderPayment,
    orderId: string,
    dto: AddDepositDto,
  ) {
    if (
      payment.orderId !== orderId ||
      payment.type !== CustomerOrderPaymentType.DEPOSIT ||
      (!dto.tenderedAmount &&
        Math.round(Number(payment.amount) * 100) !==
          Math.round(dto.amount * 100))
    ) {
      throw new ConflictException(
        'This idempotency key was already used for another payment',
      );
    }
    return this.findOne(payment.tenantId, orderId);
  }

  private async people(ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, { id: string; name: string }>();
    const rows = await this.dataSource.query<{ id: string; name: string }[]>(
      `SELECT u.id, ${PERSON('u')} AS name FROM users u WHERE u.id = ANY($1::uuid[])`,
      [unique],
    );
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async names(table: 'branches', column: 'name', ids: string[]) {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map<string, string>();
    const rows = await this.dataSource.query<{ id: string; name: string }[]>(
      `SELECT id, "${column}" AS name FROM "${table}" WHERE id = ANY($1::uuid[])`,
      [unique],
    );
    return new Map(rows.map((r) => [r.id, r.name]));
  }
}
