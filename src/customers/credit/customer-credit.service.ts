import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Customer } from '../../database/entities/customer.entity';
import { CustomerGroup } from '../../database/entities/customer-group.entity';
import {
  CustomerCreditEntry,
  CustomerCreditEntryType,
} from '../../database/entities/customer-credit-entry.entity';
import { CustomerCreditAllocation } from '../../database/entities/customer-credit-allocation.entity';
import {
  PaymentMethod,
  PaymentMethodStatus,
  PaymentMethodType,
} from '../../database/entities/payment-method.entity';
import { CashMovementType } from '../../database/entities/cash-movement.entity';
import type { AuthUser } from '../../auth/strategies/jwt.strategy';
import { AuditService } from '../../audit/audit.service';
import { ApprovalsService } from '../../approvals/approvals.service';
import { assertRegisterAccess, branchScope } from '../../auth/branch-scope';
import { ShiftsService } from '../../shifts/shifts.service';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { requestContext } from '../../common/context/request-context';
import { isPgError, PG_UNIQUE_VIOLATION } from '../../common/utils/pg-error';
import { paginate } from '../../common/dto/pagination.dto';
import { approvalRequired } from '../../sales/sale-authorization';
import { returnedRows, specialTenderOf } from '../../sales/special-tenders';
import { LOYALTY_METHOD_CODE } from '../../loyalty/loyalty.service';
import {
  Aging,
  agingOf,
  allocateFifo,
  availableCredit,
  buildStatement,
  dueDateFor,
  ledgerSum,
  OpenCredit,
  OpenDebit,
  paymentTerms,
  sumAging,
} from './credit-math';
import {
  AdjustCustomerAccountDto,
  AgingQueryDto,
  CreditEntriesQueryDto,
  RecordCustomerPaymentDto,
} from './customer-credit.dto';
import { needsSecondPerson, SECOND_PERSON_THRESHOLD } from './second-person';
import { containsPattern } from '../../common/utils/like';

export interface PostEntryInput {
  tenantId: string;
  customerId: string;
  type: CustomerCreditEntryType;
  // Signed: + the customer owes more
  amount: number;
  saleId?: string | null;
  returnId?: string | null;
  paymentMethodId?: string | null;
  paymentRef?: string | null;
  dueDate?: string | null;
  reversalOfId?: string | null;
  note?: string | null;
  idempotencyKey?: string | null;
  approverId?: string | null;
  // Charges on account: refused on credit hold, and above the limit unless allowed
  checkCredit?: { allowOverLimit: boolean };
}

/** What a charge on account needs before it can be posted (for approvals) */
export interface ChargeCheck {
  creditHold: boolean;
  creditLimit: number;
  balance: number;
  available: number;
  exceedsLimit: boolean;
}

const cents = (value: number | string) => Math.round(Number(value) * 100);

// Who may see account balances (the payment route itself only needs customers.credit.receive)
const seesFinance = (user: Pick<AuthUser, 'permissions'>) =>
  user.permissions?.includes('customers.finance.view') ?? false;

/** Payment result without the balance, for users who may not see it */
export interface PaymentResult {
  entry: Partial<CustomerCreditEntry>;
  account?: Awaited<ReturnType<CustomerCreditService['account']>>;
}

// Methods a customer can pay their account with (money actually received)
const PAYABLE_TYPES: readonly PaymentMethodType[] = [
  PaymentMethodType.CASH,
  PaymentMethodType.CARD,
  PaymentMethodType.MOBILE,
  PaymentMethodType.BANK_TRANSFER,
  PaymentMethodType.CHECK,
  PaymentMethodType.OTHER,
];

interface LedgerRow {
  id: string;
  amount: string | number;
  dueDate: string | null;
  createdAt: Date;
  saleId: string | null;
  reversalOfId: string | null;
  type: CustomerCreditEntryType;
  open: string | number;
}

/**
 * Customer accounts (D019): an append-only ledger, the balance projection on
 * customers.currentBalance (changed only here, in the entry's transaction),
 * FIFO settlement, statements and aging.
 */
@Injectable()
export class CustomerCreditService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
    private shiftsService: ShiftsService,
    @Optional() private outbox?: OutboxService,
    @Optional() private approvalsService?: ApprovalsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Posting (inside the caller's transaction)

  /**
   * Append an entry and move the balance projection with one guarded UPDATE:
   * a charge on account is refused while the customer is on credit hold, and
   * above the credit limit unless allowed — atomically, so two tills can't both
   * use the last of the limit. Then settles open charges (FIFO).
   */
  async post(
    manager: EntityManager,
    input: PostEntryInput,
  ): Promise<CustomerCreditEntry> {
    const amount = Math.round(Number(input.amount) * 100) / 100;
    if (amount === 0) {
      throw new BadRequestException('An account entry needs an amount');
    }
    const check = input.checkCredit;
    const rows = returnedRows<{
      balance: string | number;
      previous: string | number;
      creditLimit: string | number;
    }>(
      await manager.query(
        `UPDATE customers
            SET "currentBalance" = "currentBalance" + $1::numeric, updated_at = NOW()
          WHERE id = $2 AND "tenantId" = $3
            AND ($4::boolean OR "creditHold" = false)
            AND ($5::boolean OR "currentBalance" + $1::numeric <= "creditLimit")
          RETURNING "currentBalance" AS balance,
                    "currentBalance" - $1::numeric AS previous,
                    "creditLimit"`,
        [
          amount,
          input.customerId,
          input.tenantId,
          !check,
          !check || check.allowOverLimit,
        ],
      ),
    );
    if (rows.length === 0) {
      await this.explainRefusal(manager, input.tenantId, input.customerId);
    }
    const balance = Number(rows[0].balance);
    const previous = Number(rows[0].previous);
    const context = requestContext.get();

    const repo = manager.getRepository(CustomerCreditEntry);
    const entry = await repo.save(
      repo.create({
        tenantId: input.tenantId,
        customerId: input.customerId,
        type: input.type,
        amount,
        balanceAfter: balance,
        saleId: input.saleId ?? null,
        returnId: input.returnId ?? null,
        paymentMethodId: input.paymentMethodId ?? null,
        paymentRef: input.paymentRef ?? null,
        dueDate: input.dueDate ?? null,
        reversalOfId: input.reversalOfId ?? null,
        note: input.note?.slice(0, 500) ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        createdById: context?.userId ?? null,
        approverId: input.approverId ?? context?.approverId ?? null,
      }),
    );

    await this.settle(manager, input.tenantId, input.customerId);

    await this.auditService.record(
      {
        tenantId: input.tenantId,
        action: `customer.credit.${input.type}`,
        entityType: 'customer',
        entityId: input.customerId,
        reason: input.note ?? null,
        approverId: input.approverId ?? undefined,
        metadata: {
          entryId: entry.id,
          amount,
          previousBalance: previous,
          balance,
          saleId: entry.saleId,
          returnId: entry.returnId,
          overLimit: check?.allowOverLimit
            ? cents(balance) > cents(rows[0].creditLimit)
            : undefined,
        },
      },
      manager,
    );
    await this.outbox?.record(manager, {
      tenantId: input.tenantId,
      type: 'customer.credit_changed',
      aggregateId: input.customerId,
      payload: {
        customerId: input.customerId,
        previousBalance: previous,
        newBalance: balance,
        creditLimit: Number(rows[0].creditLimit),
        reason: input.type,
      },
    });
    return entry;
  }

  /** Why a guarded posting was refused */
  private async explainRefusal(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
  ): Promise<never> {
    const customer = await manager.findOne(Customer, {
      where: { id: customerId, tenantId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    if (customer.creditHold) {
      throw new BadRequestException(
        'This customer is on credit hold: no new sales on account',
      );
    }
    throw approvalRequired(
      'customers.credit.override',
      "This sale would take the customer over their credit limit. A manager's approval is needed.",
    );
  }

  /**
   * Put (part of) a sale on the customer's account, due after their payment terms
   */
  async chargeSale(
    manager: EntityManager,
    input: {
      tenantId: string;
      customerId: string;
      saleId: string;
      saleNumber: string;
      amount: number;
      saleDate: Date;
      allowOverLimit: boolean;
      approverId?: string | null;
    },
  ): Promise<CustomerCreditEntry> {
    const customer = await manager.findOne(Customer, {
      where: { id: input.customerId, tenantId: input.tenantId },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    const group = customer.groupId
      ? await manager.findOne(CustomerGroup, {
          where: { id: customer.groupId, tenantId: input.tenantId },
        })
      : null;
    return this.post(manager, {
      tenantId: input.tenantId,
      customerId: input.customerId,
      type: CustomerCreditEntryType.CHARGE,
      amount: input.amount,
      saleId: input.saleId,
      dueDate: dueDateFor(input.saleDate, paymentTerms(customer, group)),
      note: `Sale ${input.saleNumber}`,
      approverId: input.approverId ?? null,
      checkCredit: { allowOverLimit: input.allowOverLimit },
    });
  }

  /**
   * Cancel what a sale still has on account (void, cancelled card sale): one
   * reversal per charge, net of earlier credit notes / reversals for the sale.
   */
  async reverseSale(
    manager: EntityManager,
    tenantId: string,
    saleId: string,
    note: string,
  ): Promise<CustomerCreditEntry[]> {
    const entries = await manager.find(CustomerCreditEntry, {
      where: { tenantId, saleId },
      order: { createdAt: 'ASC' },
    });
    const posted: CustomerCreditEntry[] = [];
    for (const charge of entries.filter(
      (e) => e.type === CustomerCreditEntryType.CHARGE,
    )) {
      // Already undone: reversals of this charge, and credit notes (returns) of the sale
      const undone = entries
        .filter(
          (e) =>
            e.reversalOfId === charge.id ||
            (e.type === CustomerCreditEntryType.CREDIT_NOTE &&
              e.customerId === charge.customerId),
        )
        .reduce((sum, e) => sum - cents(e.amount), 0);
      const left = cents(charge.amount) - undone;
      if (left <= 0) continue;
      posted.push(
        await this.post(manager, {
          tenantId,
          customerId: charge.customerId,
          type: CustomerCreditEntryType.REVERSAL,
          amount: -left / 100,
          saleId,
          reversalOfId: charge.id,
          note,
        }),
      );
    }
    return posted;
  }

  /** Amount a sale has on the customer's account, net of credit notes and reversals */
  async saleOnAccount(
    manager: EntityManager,
    tenantId: string,
    saleId: string,
  ): Promise<number> {
    const [row] = await manager.query<{ total: string | null }[]>(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM customer_credit_entries
        WHERE "tenantId" = $1 AND "saleId" = $2`,
      [tenantId, saleId],
    );
    return Number(row?.total ?? 0);
  }

  /** A return of goods bought on account reduces the charge (credit note) */
  creditNote(
    manager: EntityManager,
    input: {
      tenantId: string;
      customerId: string;
      saleId: string;
      returnId: string;
      amount: number;
      note: string;
    },
  ): Promise<CustomerCreditEntry> {
    return this.post(manager, {
      tenantId: input.tenantId,
      customerId: input.customerId,
      type: CustomerCreditEntryType.CREDIT_NOTE,
      amount: -Math.abs(input.amount),
      saleId: input.saleId,
      returnId: input.returnId,
      note: input.note,
    });
  }

  /**
   * Allocate unapplied credits to open debits (FIFO, a credit tied to a charge
   * settles it first). Runs after every posting, under the customer row lock
   * taken by the balance UPDATE.
   */
  async settle(manager: EntityManager, tenantId: string, customerId: string) {
    const rows = await this.openRows(manager, tenantId, customerId);
    const debits: OpenDebit[] = [];
    const credits: OpenCredit[] = [];
    for (const row of rows) {
      if (Number(row.open) <= 0) continue;
      if (Number(row.amount) > 0) {
        debits.push({
          id: row.id,
          open: Number(row.open),
          dueDate: row.dueDate,
          createdAt: row.createdAt,
          saleId: row.saleId,
        });
      } else {
        credits.push({
          id: row.id,
          open: Number(row.open),
          createdAt: row.createdAt,
          targetDebitId:
            row.reversalOfId ??
            (row.saleId
              ? (debits.find((d) => d.saleId === row.saleId)?.id ?? null)
              : null),
        });
      }
    }
    // Credit notes may come before their charge in the rows: resolve targets again
    for (const credit of credits) {
      if (credit.targetDebitId) continue;
      const row = rows.find((r) => r.id === credit.id);
      if (row?.saleId) {
        credit.targetDebitId =
          debits.find((d) => d.saleId === row.saleId)?.id ?? null;
      }
    }
    if (!debits.length || !credits.length) return;
    const allocations = allocateFifo(debits, credits);
    if (!allocations.length) return;
    await manager.insert(
      CustomerCreditAllocation,
      allocations.map((a) => ({ ...a, tenantId, customerId })),
    );
  }

  private openRows(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
  ): Promise<LedgerRow[]> {
    return manager.query<LedgerRow[]>(
      `SELECT e.id, e.type, e.amount, e."dueDate"::text AS "dueDate", e.created_at AS "createdAt",
              e."saleId", e."reversalOfId",
              ABS(e.amount) - COALESCE((
                SELECT SUM(a.amount) FROM customer_credit_allocations a
                 WHERE a."debitEntryId" = e.id OR a."creditEntryId" = e.id), 0) AS open
         FROM customer_credit_entries e
        WHERE e."tenantId" = $1 AND e."customerId" = $2
        ORDER BY e.created_at ASC`,
      [tenantId, customerId],
    );
  }

  // ---------------------------------------------------------------------------
  // Checks for the till (before the sale transaction, to ask for approvals)

  async checkCharge(
    tenantId: string,
    customerId: string,
    amount: number,
  ): Promise<ChargeCheck> {
    const customer = await this.dataSource
      .getRepository(Customer)
      .findOne({ where: { id: customerId, tenantId } });
    if (!customer) throw new NotFoundException('Customer not found');
    const balance = Number(customer.currentBalance);
    const creditLimit = Number(customer.creditLimit);
    return {
      creditHold: customer.creditHold,
      creditLimit,
      balance,
      available: availableCredit(creditLimit, balance),
      exceedsLimit: cents(balance) + cents(amount) > cents(creditLimit),
    };
  }

  // ---------------------------------------------------------------------------
  // Payments and adjustments (their own transaction)

  /**
   * Money received on the account (till or back office). Cash goes into the open
   * shift of the register as a paid-in movement (sourceType customer_payment).
   * A payment larger than what the customer owes is refused.
   */
  async recordPayment(
    tenantId: string,
    user: AuthUser,
    customerId: string,
    dto: RecordCustomerPaymentDto,
    approvalToken?: string,
  ): Promise<PaymentResult> {
    if (dto.idempotencyKey) {
      const existing = await this.dataSource
        .getRepository(CustomerCreditEntry)
        .findOne({ where: { tenantId, idempotencyKey: dto.idempotencyKey } });
      if (existing) return this.replayPayment(existing, user, customerId, dto);
    }
    const method = await this.dataSource
      .getRepository(PaymentMethod)
      .findOne({ where: { id: dto.paymentMethodId, tenantId } });
    if (
      !method ||
      method.status !== PaymentMethodStatus.ACTIVE ||
      !PAYABLE_TYPES.includes(method.methodType) ||
      specialTenderOf(method) ||
      method.code === LOYALTY_METHOD_CODE
    ) {
      throw new BadRequestException(
        'Choose how the customer paid (cash, card, transfer, cheque...)',
      );
    }
    if (method.requiresReference && !dto.reference?.trim()) {
      throw new BadRequestException(
        `${method.name?.en ?? method.code} payments need a reference`,
      );
    }
    const isCash = method.methodType === PaymentMethodType.CASH;
    if (isCash && !dto.registerId) {
      throw new BadRequestException('Choose the register the cash goes into');
    }
    // Cash is counted in the drawer; money said to arrive another way (card,
    // transfer, cheque) clears debt with nothing to count, so a large one needs
    // a second person's sign-off
    const approverId =
      !isCash && needsSecondPerson(dto.amount)
        ? await this.secondPerson(user, approvalToken)
        : null;

    try {
      const entryId = await this.dataSource.transaction(async (manager) => {
        // The register must be of this store and at one of the user's branches
        if (dto.registerId) {
          await assertRegisterAccess(
            manager,
            tenantId,
            dto.registerId,
            'Register not found',
            branchScope(user),
          );
        }
        const customer = await manager.findOne(Customer, {
          where: { id: customerId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!customer) throw new NotFoundException('Customer not found');
        if (cents(dto.amount) > cents(customer.currentBalance)) {
          // The amount owed only for those who may see balances
          throw new BadRequestException(
            seesFinance(user)
              ? `The customer owes ${Number(customer.currentBalance).toFixed(2)}: a payment can't be more than that`
              : "A payment can't be more than what the customer owes",
          );
        }
        const shift =
          isCash && dto.registerId
            ? await this.shiftsService.getOpenShift(
                tenantId,
                dto.registerId,
                manager,
              )
            : null;
        if (isCash && !shift) {
          throw new ConflictException(
            'Open a shift on this register to take a cash payment',
          );
        }
        // Cash goes into the user's own drawer or a shared one, never into
        // another cashier's (getOpenShift falls back to any open shift)
        if (shift && shift.openedById !== user.id && !shift.shared) {
          throw new ConflictException(
            'Open your own shift on this register to take a cash payment',
          );
        }
        const entry = await this.post(manager, {
          tenantId,
          customerId,
          type: CustomerCreditEntryType.PAYMENT,
          amount: -dto.amount,
          paymentMethodId: method.id,
          paymentRef: dto.reference?.trim() || null,
          note:
            dto.note?.trim() || `Payment (${method.name?.en ?? method.code})`,
          idempotencyKey: dto.idempotencyKey ?? null,
          approverId,
        });
        if (shift) {
          await this.shiftsService.recordCashMovement(manager, {
            tenantId,
            shiftId: shift.id,
            type: CashMovementType.PAID_IN,
            amount: dto.amount,
            userId: user.id,
            reason: `Payment on account ${customer.code}`,
            reference: dto.reference?.trim() || null,
            sourceType: 'customer_payment',
            sourceId: entry.id,
          });
        }
        return entry.id;
      });
      const entry = await this.dataSource
        .getRepository(CustomerCreditEntry)
        .findOneOrFail({ where: { id: entryId, tenantId } });
      return this.paymentResult(entry, user, customerId);
    } catch (error) {
      if (
        dto.idempotencyKey &&
        isPgError(error, PG_UNIQUE_VIOLATION, 'uq_credit_entry_idempotency')
      ) {
        const winner = await this.dataSource
          .getRepository(CustomerCreditEntry)
          .findOneOrFail({
            where: { tenantId, idempotencyKey: dto.idempotencyKey },
          });
        return this.replayPayment(winner, user, customerId, dto);
      }
      throw error;
    }
  }

  /**
   * The approver of a large non-cash payment: someone else holding
   * customers.credit.manage, via a manager approval token (X-Approval-Token,
   * comma-separated when the route's own permission was approved too). Needed
   * even when the user holds the permission.
   */
  private async secondPerson(
    user: AuthUser,
    approvalToken?: string,
  ): Promise<string> {
    const tokens = (approvalToken ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    for (const token of tokens) {
      const approverId = await this.approvalsService?.verify(
        token,
        'customers.credit.manage',
        user,
      );
      if (approverId && approverId !== user.id) return approverId;
    }
    throw approvalRequired(
      'customers.credit.manage',
      `Non-cash payments over ${SECOND_PERSON_THRESHOLD.toFixed(2)} need a manager's approval.`,
    );
  }

  /**
   * What the payment route returns: the entry, plus the account for users who
   * may see balances (customers.finance.view); others get the entry without
   * the balance it left.
   */
  private async paymentResult(
    entry: CustomerCreditEntry,
    user: AuthUser,
    customerId: string,
  ): Promise<PaymentResult> {
    if (seesFinance(user)) {
      return {
        entry,
        account: await this.account(entry.tenantId, customerId),
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { balanceAfter, ...visible } = entry;
    return { entry: visible };
  }

  private async replayPayment(
    entry: CustomerCreditEntry,
    user: AuthUser,
    customerId: string,
    dto: RecordCustomerPaymentDto,
  ): Promise<PaymentResult> {
    if (
      entry.customerId !== customerId ||
      entry.type !== CustomerCreditEntryType.PAYMENT ||
      cents(entry.amount) !== -cents(dto.amount)
    ) {
      throw new ConflictException(
        'This idempotency key was already used for a different payment',
      );
    }
    return this.paymentResult(entry, user, customerId);
  }

  /** Manual correction (reason required, audited) or the opening balance */
  async adjust(
    tenantId: string,
    customerId: string,
    dto: AdjustCustomerAccountDto,
  ) {
    if (cents(dto.amount) === 0) {
      throw new BadRequestException('Enter an amount other than zero');
    }
    const opening = dto.type === 'opening_balance';
    await this.dataSource.transaction(async (manager) => {
      const customer = await manager.findOne(Customer, {
        where: { id: customerId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!customer) throw new NotFoundException('Customer not found');
      if (opening) {
        const count = await manager.count(CustomerCreditEntry, {
          where: { tenantId, customerId },
        });
        if (count > 0) {
          throw new ConflictException(
            'The opening balance can only be the first entry of the account; post an adjustment instead',
          );
        }
      }
      await this.post(manager, {
        tenantId,
        customerId,
        type: opening
          ? CustomerCreditEntryType.OPENING_BALANCE
          : CustomerCreditEntryType.ADJUSTMENT,
        amount: dto.amount,
        dueDate: dto.amount > 0 ? dueDateFor(new Date(), 0) : null,
        note: dto.reason.trim(),
      });
    });
    return this.account(tenantId, customerId);
  }

  // ---------------------------------------------------------------------------
  // Reading

  /** Balance as the sum of the ledger (reconciliation compares it with the projection) */
  async ledgerBalance(tenantId: string, customerId: string): Promise<number> {
    const rows = await this.dataSource.query<{ amount: string }[]>(
      `SELECT amount FROM customer_credit_entries WHERE "tenantId" = $1 AND "customerId" = $2`,
      [tenantId, customerId],
    );
    return ledgerSum(rows.map((r) => r.amount));
  }

  /** Account summary: balance, limit, terms, hold and aging */
  async account(tenantId: string, customerId: string, asOf = new Date()) {
    const customer = await this.dataSource.getRepository(Customer).findOne({
      where: { id: customerId, tenantId },
      relations: { group: true },
    });
    if (!customer) throw new NotFoundException('Customer not found');
    const balance = Number(customer.currentBalance);
    const creditLimit = Number(customer.creditLimit);
    return {
      customerId,
      balance,
      ledgerBalance: await this.ledgerBalance(tenantId, customerId),
      creditLimit,
      available: availableCredit(creditLimit, balance),
      creditHold: customer.creditHold,
      paymentTermDays: paymentTerms(customer, customer.group),
      aging: await this.agingFor(
        this.dataSource.manager,
        tenantId,
        customerId,
        asOf,
      ),
    };
  }

  private async agingFor(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
    asOf: Date,
  ): Promise<Aging> {
    const rows = await this.openRows(manager, tenantId, customerId);
    const debits = rows.filter(
      (r) => Number(r.amount) > 0 && Number(r.open) > 0,
    );
    const unapplied = rows
      .filter((r) => Number(r.amount) < 0 && Number(r.open) > 0)
      .reduce((sum, r) => sum + cents(r.open), 0);
    return agingOf(
      debits.map((d) => ({ open: Number(d.open), dueDate: d.dueDate })),
      asOf,
      unapplied / 100,
    );
  }

  async entries(
    tenantId: string,
    customerId: string,
    query: CreditEntriesQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const qb = this.dataSource
      .getRepository(CustomerCreditEntry)
      .createQueryBuilder('e')
      .where('e.tenantId = :tenantId AND e.customerId = :customerId', {
        tenantId,
        customerId,
      })
      .orderBy('e.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.from) qb.andWhere('e.createdAt >= :from', { from: query.from });
    if (query.to) qb.andWhere('e.createdAt <= :to', { to: query.to });
    const [data, total] = await qb.getManyAndCount();
    return paginate(data, total, page, limit);
  }

  /** Statement for a period: opening balance, entries, closing balance */
  async statement(
    tenantId: string,
    customerId: string,
    from: string,
    to: string,
  ) {
    const customer = await this.dataSource
      .getRepository(Customer)
      .findOne({ where: { id: customerId, tenantId } });
    if (!customer) throw new NotFoundException('Customer not found');
    const start = new Date(from);
    const end = new Date(to);
    // A date-only "to" covers that whole day
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) end.setUTCDate(end.getUTCDate() + 1);
    if (!(start < end)) {
      throw new BadRequestException('The statement period is empty');
    }
    const [{ opening }] = await this.dataSource.query<{ opening: string }[]>(
      `SELECT COALESCE(SUM(amount), 0) AS opening FROM customer_credit_entries
        WHERE "tenantId" = $1 AND "customerId" = $2 AND created_at < $3`,
      [tenantId, customerId, start],
    );
    const entries = await this.dataSource
      .getRepository(CustomerCreditEntry)
      .createQueryBuilder('e')
      .where('e.tenantId = :tenantId AND e.customerId = :customerId', {
        tenantId,
        customerId,
      })
      .andWhere('e.createdAt >= :start AND e.createdAt < :end', { start, end })
      .orderBy('e.createdAt', 'ASC')
      .getMany();
    return {
      customer: {
        id: customer.id,
        code: customer.code,
        firstName: customer.firstName,
        lastName: customer.lastName,
        companyName: customer.companyName,
        email: customer.email,
        phone: customer.phone,
      },
      from,
      to,
      ...buildStatement(Number(opening), entries),
      aging: await this.agingFor(
        this.dataSource.manager,
        tenantId,
        customerId,
        new Date(Math.min(end.getTime() - 1, Date.now())),
      ),
    };
  }

  /**
   * Aging of every customer with an account (non-zero balance by default),
   * with the totals per bucket
   */
  async agingReport(tenantId: string, query: AgingQueryDto) {
    const asOf = query.asOf ? new Date(query.asOf) : new Date();
    const params: unknown[] = [tenantId];
    let where = `c."tenantId" = $1 AND EXISTS (SELECT 1 FROM customer_credit_entries e WHERE e."customerId" = c.id AND e."tenantId" = c."tenantId")`;
    if (query.nonZero !== 'false') where += ` AND c."currentBalance" <> 0`;
    if (query.search) {
      params.push(containsPattern(query.search));
      where += ` AND (c.code ILIKE $2 OR c."companyName" ILIKE $2 OR CONCAT_WS(' ', c."firstName", c."lastName") ILIKE $2)`;
    }
    const customers = await this.dataSource.query<
      {
        id: string;
        code: string;
        firstName: string | null;
        lastName: string | null;
        companyName: string | null;
        currentBalance: string;
        creditLimit: string;
        creditHold: boolean;
      }[]
    >(
      `SELECT c.id, c.code, c."firstName", c."lastName", c."companyName",
              c."currentBalance", c."creditLimit", c."creditHold"
         FROM customers c WHERE ${where}
        ORDER BY c."currentBalance" DESC LIMIT 500`,
      params,
    );
    const rows = [];
    for (const customer of customers) {
      const aging = await this.agingFor(
        this.dataSource.manager,
        tenantId,
        customer.id,
        asOf,
      );
      rows.push({
        customerId: customer.id,
        code: customer.code,
        name:
          [customer.firstName, customer.lastName].filter(Boolean).join(' ') ||
          customer.companyName ||
          customer.code,
        balance: Number(customer.currentBalance),
        creditLimit: Number(customer.creditLimit),
        creditHold: customer.creditHold,
        aging,
      });
    }
    return {
      asOf: asOf.toISOString(),
      rows,
      totals: sumAging(rows.map((r) => r.aging)),
    };
  }
}
