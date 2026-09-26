import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  StoredValueAccount,
  StoredValueStatus,
  StoredValueType,
} from '../database/entities/stored-value-account.entity';
import {
  StoredValueEntry,
  StoredValueEntryType,
} from '../database/entities/stored-value-entry.entity';
import { Customer } from '../database/entities/customer.entity';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../platform/outbox/outbox.service';
import { SettingsService } from '../settings/settings.service';
import { requestContext } from '../common/context/request-context';
import { paginate } from '../common/dto/pagination.dto';
import { returnedRows } from '../sales/special-tenders';
import { round2 } from '../sales/sale-calculator';
import {
  formatGiftCardCode,
  generateGiftCardCode,
  hashGiftCardCode,
  isValidGiftCardCode,
  last4Of,
} from './gift-card-code';
import { ListStoredValueQueryDto } from './stored-value.dto';
import { ApprovalsService } from '../approvals/approvals.service';
import { approvalRequired } from '../sales/sale-authorization';
import { needsSecondPerson } from '../customers/credit/second-person';
import type { Permission } from '../auth/permissions';

/** Who is asking, and the manager approval tokens sent with the request */
export interface StoredValueRequester {
  user: { id: string; tenantId: string | null };
  // X-Approval-Token header (comma-separated when several are sent)
  approvalToken?: string | null;
}

/** Permission of the manual credit / adjustment routes (and of their approval) */
const CREDIT_PERMISSION: Permission = 'customers.credit.manage';

export interface MovementInput {
  tenantId: string;
  accountId: string;
  type: StoredValueEntryType;
  // Signed
  amount: number;
  saleId?: string | null;
  paymentId?: string | null;
  returnId?: string | null;
  note?: string | null;
  // Second person who approved a manual credit / adjustment (audited)
  approverId?: string | null;
}

/** A gift card sold on a sale, as handed back to the till (code shown once) */
export interface IssuedGiftCard {
  accountId: string;
  saleItemId: string | null;
  // The full code: only in the response that sold the card, never stored
  code: string;
  last4: string;
  amount: number;
  status: StoredValueStatus;
}

const cents = (value: number | string) => Math.round(Number(value) * 100);

/** When a gift card sold now expires: `months` later (0 or less: never). */
export function giftCardExpiry(now: Date, months: number): Date | null {
  const whole = Math.floor(Number(months) || 0);
  if (whole <= 0) return null;
  const at = new Date(now);
  const day = at.getUTCDate();
  at.setUTCDate(1);
  at.setUTCMonth(at.getUTCMonth() + whole);
  // 31 January + 1 month = 28/29 February, not 2/3 March
  const lastDay = new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0),
  ).getUTCDate();
  at.setUTCDate(Math.min(day, lastDay));
  return at;
}

/** Balance, status and last 4 only: what a gift card lookup reveals */
export const publicView = (account: StoredValueAccount) => ({
  id: account.id,
  accountType: account.accountType,
  last4: account.last4,
  customerId: account.customerId,
  balance: Number(account.balance),
  initialAmount: Number(account.initialAmount),
  currencyCode: account.currencyCode,
  status: account.status,
  expiresAt: account.expiresAt,
  saleId: account.saleId,
  createdAt: account.createdAt,
});

/**
 * Gift cards and store credit (spec §11). Balances only change through
 * move(): one guarded UPDATE (never below zero, active and unexpired for
 * spending) plus an append-only entry, an audit record and an outbox event,
 * all in the caller's transaction. Concurrent redemptions of the same card
 * queue on the row; the second one fails if the balance ran out.
 */
@Injectable()
export class StoredValueService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
    @Optional() private outbox?: OutboxService,
    // Gift card expiry setting (optional: without it cards never expire)
    @Optional() private settingsService?: SettingsService,
    // Second-person approval of large manual credits (global ApprovalsModule)
    @Optional() private approvalsService?: ApprovalsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Movements

  async move(
    manager: EntityManager,
    input: MovementInput,
  ): Promise<StoredValueEntry> {
    const amount = Math.round(Number(input.amount) * 100) / 100;
    if (amount === 0) {
      throw new BadRequestException('A stored value movement needs an amount');
    }
    // Spending needs an active, unexpired account; adding value needs it active
    // (activation of a pending gift card is the only move on a pending one).
    // Writing off an expired card's value is not spending.
    const spending =
      amount < 0 &&
      input.type !== StoredValueEntryType.REVERSAL &&
      input.type !== StoredValueEntryType.EXPIRE;
    const rows = returnedRows<{
      balance: string | number;
      previous: string | number;
      accountType: StoredValueType;
      customerId: string | null;
    }>(
      await manager.query(
        `UPDATE stored_value_accounts
            SET balance = balance + $1::numeric, updated_at = NOW(), version = version + 1
          WHERE id = $2 AND "tenantId" = $3
            AND balance + $1::numeric >= 0
            AND (status = 'active' OR ($4::boolean AND status = 'pending'))
            AND (NOT $5::boolean OR "expiresAt" IS NULL OR "expiresAt" > NOW())
          RETURNING balance, balance - $1::numeric AS previous, "accountType", "customerId"`,
        [
          amount,
          input.accountId,
          input.tenantId,
          input.type === StoredValueEntryType.ISSUE,
          spending,
        ],
      ),
    );
    if (rows.length === 0) {
      const account = await manager.findOne(StoredValueAccount, {
        where: { id: input.accountId, tenantId: input.tenantId },
      });
      if (!account)
        throw new NotFoundException('Gift card or credit not found');
      if (account.status === StoredValueStatus.VOID) {
        throw new BadRequestException('This gift card / credit is cancelled');
      }
      if (account.expiresAt && new Date(account.expiresAt) <= new Date()) {
        throw new BadRequestException('This gift card has expired');
      }
      if (account.status === StoredValueStatus.PENDING) {
        throw new BadRequestException(
          'This gift card is not active yet (its sale is waiting for payment)',
        );
      }
      throw new BadRequestException(
        `Not enough balance: ${Number(account.balance).toFixed(2)} available`,
      );
    }
    const balance = Number(rows[0].balance);
    const previous = Number(rows[0].previous);
    const context = requestContext.get();
    const repo = manager.getRepository(StoredValueEntry);
    const entry = await repo.save(
      repo.create({
        tenantId: input.tenantId,
        accountId: input.accountId,
        type: input.type,
        amount,
        balanceAfter: balance,
        saleId: input.saleId ?? null,
        paymentId: input.paymentId ?? null,
        returnId: input.returnId ?? null,
        note: input.note?.slice(0, 500) ?? null,
        createdById: context?.userId ?? null,
      }),
    );
    await this.auditService.record(
      {
        tenantId: input.tenantId,
        action: `stored_value.${input.type}`,
        entityType: 'stored_value_account',
        entityId: input.accountId,
        reason: input.note ?? null,
        ...(input.approverId ? { approverId: input.approverId } : {}),
        metadata: {
          entryId: entry.id,
          ...(input.approverId ? { approverId: input.approverId } : {}),
          amount,
          previousBalance: previous,
          balance,
          saleId: entry.saleId,
          returnId: entry.returnId,
        },
      },
      manager,
    );
    await this.outbox?.record(manager, {
      tenantId: input.tenantId,
      type: 'stored_value.changed',
      aggregateId: input.accountId,
      payload: {
        accountId: input.accountId,
        accountType: rows[0].accountType,
        customerId: rows[0].customerId ?? null,
        entryId: entry.id,
        entryType: input.type,
        amount,
        previousBalance: previous,
        newBalance: balance,
        saleId: entry.saleId,
        returnId: entry.returnId,
      },
    });
    return entry;
  }

  /** Spend value as a payment (never overdraws) */
  redeem(
    manager: EntityManager,
    input: {
      tenantId: string;
      accountId: string;
      amount: number;
      saleId: string;
      paymentId?: string | null;
    },
  ) {
    return this.move(manager, {
      ...input,
      type: StoredValueEntryType.REDEEM,
      amount: -Math.abs(input.amount),
    });
  }

  /** A refund paid onto a gift card or store credit */
  refundTo(
    manager: EntityManager,
    input: {
      tenantId: string;
      accountId: string;
      amount: number;
      saleId?: string | null;
      returnId?: string | null;
      note?: string | null;
    },
  ) {
    return this.move(manager, {
      ...input,
      type: StoredValueEntryType.REFUND_CREDIT,
      amount: Math.abs(input.amount),
    });
  }

  /**
   * Give back what a sale spent from gift cards / store credit (void, cancelled
   * card sale), net of what was already given back
   */
  async reverseSaleRedemptions(
    manager: EntityManager,
    tenantId: string,
    saleId: string,
    note: string,
  ) {
    const entries = await manager.find(StoredValueEntry, {
      where: {
        tenantId,
        saleId,
        type: In([
          StoredValueEntryType.REDEEM,
          StoredValueEntryType.REVERSAL,
          StoredValueEntryType.REFUND_CREDIT,
        ]),
      },
    });
    const net = new Map<string, number>();
    for (const entry of entries) {
      // Reversals of the sale's own gift cards (sold on it) are not redemptions
      const issued =
        entry.type === StoredValueEntryType.REVERSAL && entry.amount < 0;
      if (issued) continue;
      net.set(
        entry.accountId,
        (net.get(entry.accountId) ?? 0) + cents(entry.amount),
      );
    }
    for (const [accountId, spent] of net) {
      if (spent >= 0) continue;
      await this.move(manager, {
        tenantId,
        accountId,
        type: StoredValueEntryType.REVERSAL,
        amount: -spent / 100,
        saleId,
        note,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Gift cards sold at the till

  /**
   * Create the gift cards sold on a sale. Active (value loaded) when the sale
   * completes at once; pending while it waits for a card payment. A code typed
   * in (pre-printed card) is used, else one is generated; only its hash is kept.
   */
  async createSaleGiftCards(
    manager: EntityManager,
    input: {
      tenantId: string;
      saleId: string;
      currencyCode: string;
      activate: boolean;
      cards: {
        amount: number;
        code?: string | null;
        saleItemId: string | null;
      }[];
    },
  ): Promise<IssuedGiftCard[]> {
    const issued: IssuedGiftCard[] = [];
    const repo = manager.getRepository(StoredValueAccount);
    const months = input.cards.length
      ? ((await this.settingsService?.getSettings(input.tenantId))
          ?.giftCardExpiryMonths ?? 0)
      : 0;
    const expiresAt = giftCardExpiry(new Date(), months);
    for (const card of input.cards) {
      if (card.code && !isValidGiftCardCode(card.code)) {
        throw new BadRequestException(
          'A gift card code has 8 to 32 letters or digits',
        );
      }
      const code = card.code
        ? formatGiftCardCode(card.code)
        : generateGiftCardCode();
      const codeHash = hashGiftCardCode(input.tenantId, code);
      const taken = await repo.exists({
        where: { tenantId: input.tenantId, codeHash },
      });
      if (taken) {
        throw new ConflictException(
          `Gift card ending ${last4Of(code)} is already in use`,
        );
      }
      const account = await repo.save(
        repo.create({
          tenantId: input.tenantId,
          accountType: StoredValueType.GIFT_CARD,
          codeHash,
          last4: last4Of(code),
          balance: 0,
          initialAmount: card.amount,
          currencyCode: input.currencyCode,
          status: StoredValueStatus.PENDING,
          expiresAt,
          saleId: input.saleId,
          saleItemId: card.saleItemId,
          createdById: requestContext.get()?.userId ?? null,
        }),
      );
      if (input.activate) {
        await this.move(manager, {
          tenantId: input.tenantId,
          accountId: account.id,
          type: StoredValueEntryType.ISSUE,
          amount: card.amount,
          saleId: input.saleId,
          note: 'Gift card sold',
        });
        await repo.update(account.id, { status: StoredValueStatus.ACTIVE });
      }
      issued.push({
        accountId: account.id,
        saleItemId: card.saleItemId,
        code,
        last4: account.last4!,
        amount: card.amount,
        status: input.activate
          ? StoredValueStatus.ACTIVE
          : StoredValueStatus.PENDING,
      });
    }
    return issued;
  }

  /** Load the value of a sale's pending gift cards once its payment is captured */
  async activateSaleGiftCards(
    manager: EntityManager,
    tenantId: string,
    saleId: string,
  ) {
    const pending = await manager.find(StoredValueAccount, {
      where: { tenantId, saleId, status: StoredValueStatus.PENDING },
    });
    for (const account of pending) {
      await this.move(manager, {
        tenantId,
        accountId: account.id,
        type: StoredValueEntryType.ISSUE,
        amount: Number(account.initialAmount),
        saleId,
        note: 'Gift card sold',
      });
      await manager.update(
        StoredValueAccount,
        { id: account.id, tenantId },
        { status: StoredValueStatus.ACTIVE },
      );
    }
  }

  /**
   * Cancel gift cards sold on a sale (void / cancel, or the returned lines):
   * only cards nobody has spent from, so the liability goes back to zero.
   */
  async voidSaleGiftCards(
    manager: EntityManager,
    input: {
      tenantId: string;
      saleId: string;
      saleItemIds?: string[];
      returnId?: string | null;
      note: string;
    },
  ): Promise<number> {
    const accounts = await manager.find(StoredValueAccount, {
      where: {
        tenantId: input.tenantId,
        saleId: input.saleId,
        accountType: StoredValueType.GIFT_CARD,
        ...(input.saleItemIds ? { saleItemId: In(input.saleItemIds) } : {}),
      },
      lock: { mode: 'pessimistic_write' },
    });
    let voided = 0;
    for (const account of accounts) {
      if (account.status === StoredValueStatus.VOID) continue;
      if (account.status === StoredValueStatus.ACTIVE) {
        if (cents(account.balance) !== cents(account.initialAmount)) {
          throw new ConflictException(
            `Gift card ending ${account.last4} has been used and can't be cancelled`,
          );
        }
        if (cents(account.balance) > 0) {
          await this.move(manager, {
            tenantId: input.tenantId,
            accountId: account.id,
            type: StoredValueEntryType.REVERSAL,
            amount: -Number(account.balance),
            saleId: input.saleId,
            returnId: input.returnId ?? null,
            note: input.note,
          });
        }
      }
      await manager.update(
        StoredValueAccount,
        { id: account.id, tenantId: input.tenantId },
        { status: StoredValueStatus.VOID },
      );
      voided++;
    }
    return voided;
  }

  // ---------------------------------------------------------------------------
  // Store credit

  /**
   * The customer's store credit account, created on first use (safe under
   * concurrency: the unique index decides, nothing aborts the transaction)
   */
  async storeCreditAccount(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
    currencyCode: string,
  ): Promise<StoredValueAccount> {
    await manager.query(
      `INSERT INTO stored_value_accounts ("tenantId", "accountType", "customerId", "currencyCode", status, "createdById")
       VALUES ($1, 'store_credit', $2, $3, 'active', $4)
       ON CONFLICT ("tenantId", "customerId") WHERE "accountType" = 'store_credit' AND "status" <> 'void'
       DO NOTHING`,
      [
        tenantId,
        customerId,
        currencyCode,
        requestContext.get()?.userId ?? null,
      ],
    );
    return manager.findOneOrFail(StoredValueAccount, {
      where: {
        tenantId,
        customerId,
        accountType: StoredValueType.STORE_CREDIT,
        status: In([StoredValueStatus.ACTIVE, StoredValueStatus.PENDING]),
      },
    });
  }

  async findStoreCredit(tenantId: string, customerId: string) {
    const account = await this.dataSource
      .getRepository(StoredValueAccount)
      .findOne({
        where: {
          tenantId,
          customerId,
          accountType: StoredValueType.STORE_CREDIT,
          status: StoredValueStatus.ACTIVE,
        },
      });
    return account ? publicView(account) : null;
  }

  // ---------------------------------------------------------------------------
  // Lookups and administration

  async findGiftCardByCode(
    manager: EntityManager,
    tenantId: string,
    code: string,
  ): Promise<StoredValueAccount | null> {
    return manager.findOne(StoredValueAccount, {
      where: {
        tenantId,
        accountType: StoredValueType.GIFT_CARD,
        codeHash: hashGiftCardCode(tenantId, code),
      },
    });
  }

  /** Balance check at the till: the card's balance, never its code */
  async lookupGiftCard(tenantId: string, code: string) {
    const account = await this.findGiftCardByCode(
      this.dataSource.manager,
      tenantId,
      code,
    );
    if (!account) throw new NotFoundException('Gift card not found');
    return publicView(account);
  }

  // ---------------------------------------------------------------------------
  // Expiry

  /**
   * Write off the remaining value of expired gift cards (daily job, see
   * GiftCardExpiryService): one 'expire' entry per card taking its balance to
   * zero, audited and published (stored_value.changed) like any movement. Each
   * card in its own transaction under its row lock; a card whose balance moved
   * meanwhile is handled with its current balance. Returns the cards expired.
   */
  async expireDue(now = new Date(), limit = 500): Promise<number> {
    const due = await this.dataSource.query<{ id: string; tenantId: string }[]>(
      `SELECT id, "tenantId" FROM stored_value_accounts
        WHERE "accountType" = 'gift_card' AND status = 'active'
          AND balance > 0 AND "expiresAt" IS NOT NULL AND "expiresAt" <= $1
        ORDER BY "expiresAt" LIMIT ${Number(limit)}`,
      [now],
    );
    let expired = 0;
    for (const card of due) {
      const done = await this.dataSource.transaction(async (manager) => {
        const [locked] = await manager.query<{ balance: string | number }[]>(
          `SELECT balance FROM stored_value_accounts
            WHERE id = $1 AND "tenantId" = $2 AND status = 'active'
              AND "expiresAt" IS NOT NULL AND "expiresAt" <= $3
            FOR UPDATE SKIP LOCKED`,
          [card.id, card.tenantId, now],
        );
        const balance = Number(locked?.balance ?? 0);
        if (cents(balance) <= 0) return false;
        await this.move(manager, {
          tenantId: card.tenantId,
          accountId: card.id,
          type: StoredValueEntryType.EXPIRE,
          amount: -balance,
          note: 'Gift card expired',
        });
        return true;
      });
      if (done) expired++;
    }
    return expired;
  }

  async list(tenantId: string, query: ListStoredValueQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const qb = this.dataSource
      .getRepository(StoredValueAccount)
      .createQueryBuilder('a')
      .leftJoin('a.customer', 'customer')
      .addSelect([
        'customer.id',
        'customer.code',
        'customer.firstName',
        'customer.lastName',
        'customer.companyName',
      ])
      .where('a.tenantId = :tenantId', { tenantId })
      .orderBy('a.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.type) qb.andWhere('a.accountType = :type', { type: query.type });
    if (query.status)
      qb.andWhere('a.status = :status', { status: query.status });
    if (query.customerId)
      qb.andWhere('a.customerId = :customerId', {
        customerId: query.customerId,
      });
    if (query.last4)
      qb.andWhere('a.last4 = :last4', { last4: query.last4.toUpperCase() });
    const [rows, total] = await qb.getManyAndCount();
    return paginate(
      rows.map((a) => ({ ...publicView(a), customer: a.customer ?? null })),
      total,
      page,
      limit,
    );
  }

  async entries(tenantId: string, accountId: string) {
    const account = await this.dataSource
      .getRepository(StoredValueAccount)
      .findOne({ where: { id: accountId, tenantId } });
    if (!account) throw new NotFoundException('Gift card or credit not found');
    const entries = await this.dataSource.getRepository(StoredValueEntry).find({
      where: { tenantId, accountId },
      order: { createdAt: 'DESC' },
      take: 500,
    });
    return { account: publicView(account), entries };
  }

  /**
   * Money given without anything received (a manual credit / positive
   * adjustment) above SECOND_PERSON_THRESHOLD needs a second person: a
   * manager approval (customers.credit.manage) from someone else, even when
   * the user holds the permission. Returns the approver, if one was needed.
   * Otherwise a 403 the frontend turns into an approval prompt.
   */
  private async secondPerson(
    amount: number,
    requester: StoredValueRequester,
  ): Promise<string | null> {
    if (!(Number(amount) > 0) || !needsSecondPerson(amount)) return null;
    const tokens = (requester.approvalToken ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (this.approvalsService) {
      for (const token of tokens) {
        const approverId = await this.approvalsService.verify(
          token,
          CREDIT_PERMISSION,
          requester.user,
        );
        // Must be someone else than the person asking
        if (approverId && approverId !== requester.user.id) return approverId;
      }
    }
    throw approvalRequired(
      CREDIT_PERMISSION,
      'Store credit of this amount needs a second person. A manager must approve it.',
    );
  }

  /** Manual correction (reason required, audited; large credits need a second person) */
  async adjust(
    tenantId: string,
    accountId: string,
    amount: number,
    reason: string,
    requester: StoredValueRequester,
  ) {
    const approverId = await this.secondPerson(amount, requester);
    await this.dataSource.transaction((manager) =>
      this.move(manager, {
        tenantId,
        accountId,
        type: StoredValueEntryType.ADJUSTMENT,
        amount,
        note: reason.trim(),
        approverId,
      }),
    );
    return this.entries(tenantId, accountId);
  }

  /** Give a customer store credit (goodwill, migration): creates the account if needed */
  async creditCustomer(
    tenantId: string,
    customerId: string,
    amount: number,
    reason: string,
    currencyCode: string,
    requester: StoredValueRequester,
  ) {
    if (!(amount > 0)) {
      throw new BadRequestException('Enter an amount greater than zero');
    }
    const approverId = await this.secondPerson(amount, requester);
    const accountId = await this.dataSource.transaction(async (manager) => {
      const customer = await manager.findOne(Customer, {
        where: { id: customerId, tenantId },
      });
      if (!customer) throw new NotFoundException('Customer not found');
      const account = await this.storeCreditAccount(
        manager,
        tenantId,
        customerId,
        currencyCode,
      );
      await this.move(manager, {
        tenantId,
        accountId: account.id,
        type: StoredValueEntryType.ADJUSTMENT,
        amount,
        note: reason.trim(),
        approverId,
      });
      return account.id;
    });
    return this.entries(tenantId, accountId);
  }
}

/**
 * Customer merge: the retired customer's store credit moves to the survivor's
 * account (entries on both), and the emptied account is voided, so the merge
 * can re-point customerId without two active store credit accounts.
 */
export async function mergeStoreCredit(
  manager: EntityManager,
  tenantId: string,
  fromCustomerId: string,
  toCustomerId: string,
): Promise<void> {
  const repo = manager.getRepository(StoredValueAccount);
  const active = {
    accountType: StoredValueType.STORE_CREDIT,
    status: StoredValueStatus.ACTIVE,
  };
  const from = await repo.findOne({
    where: { tenantId, customerId: fromCustomerId, ...active },
    lock: { mode: 'pessimistic_write' },
  });
  const to = await repo.findOne({
    where: { tenantId, customerId: toCustomerId, ...active },
    lock: { mode: 'pessimistic_write' },
  });
  if (!from || !to) return;
  const amount = Number(from.balance);
  const entries = manager.getRepository(StoredValueEntry);
  const userId = requestContext.get()?.userId ?? null;
  if (cents(amount) > 0) {
    await manager.query(
      `UPDATE stored_value_accounts SET balance = balance - $1::numeric, updated_at = NOW() WHERE id = $2`,
      [amount, from.id],
    );
    await manager.query(
      `UPDATE stored_value_accounts SET balance = balance + $1::numeric, updated_at = NOW() WHERE id = $2`,
      [amount, to.id],
    );
    await entries.insert([
      {
        tenantId,
        accountId: from.id,
        type: StoredValueEntryType.ADJUSTMENT,
        amount: -amount,
        balanceAfter: 0,
        note: 'Moved to the surviving customer on merge',
        createdById: userId,
      },
      {
        tenantId,
        accountId: to.id,
        type: StoredValueEntryType.ADJUSTMENT,
        amount,
        balanceAfter: round2(Number(to.balance) + amount),
        note: 'Moved from a merged customer',
        createdById: userId,
      },
    ]);
  }
  await repo.update(from.id, { status: StoredValueStatus.VOID });
}
