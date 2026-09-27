import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../platform/outbox/outbox.service';
import {
  StoredValueAccount,
  StoredValueStatus,
  StoredValueType,
} from '../database/entities/stored-value-account.entity';
import { StoredValueEntryType } from '../database/entities/stored-value-entry.entity';
import { giftCardExpiry, StoredValueService } from './stored-value.service';
import { GiftCardExpiryService } from './gift-card-expiry.service';
import type { SettingsService } from '../settings/settings.service';
import { ConfigService } from '@nestjs/config';
import { hmacGiftCardCode, legacyHashGiftCardCode } from './gift-card-code';
import type { ApprovalsService } from '../approvals/approvals.service';
import { SECOND_PERSON_THRESHOLD } from '../customers/credit/second-person';

const TENANT = 'tenant-1';

/**
 * A fake database for one account: the guarded UPDATE is applied atomically
 * (check and change in one step), as Postgres does under its row lock.
 */
function fakeDb(balance: number, status = StoredValueStatus.ACTIVE) {
  const account = {
    id: 'acc-1',
    tenantId: TENANT,
    accountType: StoredValueType.GIFT_CARD,
    customerId: null,
    balance,
    initialAmount: balance,
    status,
    last4: '6789',
    expiresAt: null as Date | null,
  };
  const entries: { type: string; amount: number; balanceAfter: number }[] = [];
  const manager = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      await Promise.resolve();
      if (sql.startsWith('UPDATE stored_value_accounts')) {
        const [amount, , , issuing, spending] = params as [
          number,
          string,
          string,
          boolean,
          boolean,
        ];
        const next = Math.round((account.balance + amount) * 100) / 100;
        const statusOk =
          account.status === StoredValueStatus.ACTIVE ||
          (issuing && account.status === StoredValueStatus.PENDING);
        const expired =
          spending && account.expiresAt && account.expiresAt <= new Date();
        if (next < 0 || !statusOk || expired) return [[], 0];
        const previous = account.balance;
        account.balance = next;
        return [
          [
            {
              balance: next,
              previous,
              accountType: account.accountType,
              customerId: null,
            },
          ],
          1,
        ];
      }
      return [];
    }),
    findOne: jest.fn(() => Promise.resolve({ ...account })),
    find: jest.fn(() => Promise.resolve([{ ...account }])),
    update: jest.fn(
      (_e: unknown, _w: unknown, patch: { status?: StoredValueStatus }) => {
        if (patch.status) account.status = patch.status;
        return Promise.resolve();
      },
    ),
    getRepository: jest.fn(() => ({
      create: (data: object) => data,
      save: jest.fn(
        (data: { type: string; amount: number; balanceAfter: number }) => {
          entries.push(data);
          return Promise.resolve({ id: `entry-${entries.length}`, ...data });
        },
      ),
    })),
  };
  return {
    account,
    entries,
    manager: manager as unknown as EntityManager,
    raw: manager,
  };
}

describe('StoredValueService', () => {
  const audit = { record: jest.fn() };
  const outbox = { record: jest.fn() };
  const service = new StoredValueService(
    {} as DataSource,
    audit as unknown as AuditService,
    outbox as unknown as OutboxService,
  );

  beforeEach(() => jest.clearAllMocks());

  it('redeems within the balance and records the entry, audit and event in the same manager', async () => {
    const db = fakeDb(50);
    await service.redeem(db.manager, {
      tenantId: TENANT,
      accountId: 'acc-1',
      amount: 20,
      saleId: 'sale-1',
    });
    expect(db.account.balance).toBe(30);
    expect(db.entries).toEqual([
      expect.objectContaining({
        type: StoredValueEntryType.REDEEM,
        amount: -20,
        balanceAfter: 30,
      }),
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'stored_value.redeem' }),
      db.manager,
    );
    expect(outbox.record).toHaveBeenCalledWith(
      db.manager,
      expect.objectContaining({
        type: 'stored_value.changed',
        payload: expect.objectContaining({
          previousBalance: 50,
          newBalance: 30,
        }) as unknown,
      }),
    );
  });

  it('never overdraws, even with two concurrent redemptions', async () => {
    const db = fakeDb(50);
    const results = await Promise.allSettled([
      service.redeem(db.manager, {
        tenantId: TENANT,
        accountId: 'acc-1',
        amount: 30,
        saleId: 's1',
      }),
      service.redeem(db.manager, {
        tenantId: TENANT,
        accountId: 'acc-1',
        amount: 30,
        saleId: 's2',
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BadRequestException);
    expect(db.account.balance).toBe(20);
    expect(db.entries).toHaveLength(1);
  });

  it('refuses to spend from a pending or cancelled card', async () => {
    const db = fakeDb(0, StoredValueStatus.PENDING);
    await expect(
      service.redeem(db.manager, {
        tenantId: TENANT,
        accountId: 'acc-1',
        amount: 5,
        saleId: 's1',
      }),
    ).rejects.toThrow('not active yet');
  });

  it('cancels only unused gift cards sold on a sale', async () => {
    const unused = fakeDb(25);
    await service.voidSaleGiftCards(unused.manager, {
      tenantId: TENANT,
      saleId: 'sale-1',
      note: 'Void',
    });
    expect(unused.account.balance).toBe(0);
    expect(unused.account.status).toBe(StoredValueStatus.VOID);
    expect(unused.entries[0]).toMatchObject({ type: 'reversal', amount: -25 });

    const used = fakeDb(25);
    used.account.balance = 10;
    await expect(
      service.voidSaleGiftCards(used.manager, {
        tenantId: TENANT,
        saleId: 'sale-1',
        note: 'Void',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('issues sold gift cards with a hashed code and returns the code once', async () => {
    const saved: Partial<StoredValueAccount>[] = [];
    const manager = {
      getRepository: () => ({
        exists: jest.fn(() => Promise.resolve(false)),
        create: (data: object) => data,
        save: jest.fn((data: Partial<StoredValueAccount>) => {
          saved.push(data);
          return Promise.resolve({ id: 'acc-new', ...data });
        }),
        update: jest.fn(),
      }),
    } as unknown as EntityManager;
    const issued = await service.createSaleGiftCards(manager, {
      tenantId: TENANT,
      saleId: 'sale-1',
      currencyCode: 'USD',
      activate: false,
      cards: [{ amount: 50, code: 'abcd-efgh-2345-6789', saleItemId: 'si-1' }],
    });
    expect(issued[0]).toMatchObject({
      code: 'ABCD-EFGH-2345-6789',
      last4: '6789',
      status: StoredValueStatus.PENDING,
    });
    expect(saved[0].codeHmac).toBe(
      service.codeHmac(TENANT, 'ABCD-EFGH-2345-6789'),
    );
    // New cards never store the legacy unkeyed hash
    expect(saved[0].codeHash).toBeNull();
    expect(JSON.stringify(saved[0])).not.toContain('ABCDEFGH23456789');
    expect(JSON.stringify(saved[0])).not.toContain('ABCD-EFGH');
  });

  describe('gift card code HMAC', () => {
    const SECRET = 'gift-card-test-secret-'.padEnd(48, 'x');
    const keyed = new StoredValueService(
      {} as DataSource,
      audit as unknown as AuditService,
      outbox as unknown as OutboxService,
      undefined,
      undefined,
      new ConfigService({ GIFT_CARD_CODE_SECRET: SECRET, NODE_ENV: 'test' }),
    );
    const CODE = 'ABCD-EFGH-2345-6789';

    it('keys the hash with GIFT_CARD_CODE_SECRET', () => {
      expect(keyed.codeHmac(TENANT, CODE)).toBe(
        hmacGiftCardCode(SECRET, TENANT, CODE),
      );
    });

    it('refuses short or digits-only pre-printed codes', async () => {
      const manager = {
        getRepository: () => ({ exists: jest.fn() }),
      } as unknown as EntityManager;
      for (const code of ['12345678', '1234-5678-9012-3456', 'ABCD-1234']) {
        await expect(
          keyed.createSaleGiftCards(manager, {
            tenantId: TENANT,
            saleId: 'sale-1',
            currencyCode: 'USD',
            activate: false,
            cards: [{ amount: 10, code, saleItemId: null }],
          }),
        ).rejects.toThrow(/12 to 32 characters/);
      }
    });

    it('refuses a code already used under either hash (unique per store)', async () => {
      const exists = jest.fn(() => Promise.resolve(true));
      const manager = {
        getRepository: () => ({ exists }),
      } as unknown as EntityManager;
      await expect(
        keyed.createSaleGiftCards(manager, {
          tenantId: TENANT,
          saleId: 'sale-1',
          currencyCode: 'USD',
          activate: false,
          cards: [{ amount: 10, code: CODE, saleItemId: null }],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(exists).toHaveBeenCalledWith({
        where: [
          {
            tenantId: TENANT,
            codeHmac: hmacGiftCardCode(SECRET, TENANT, CODE),
          },
          { tenantId: TENANT, codeHash: legacyHashGiftCardCode(TENANT, CODE) },
        ],
      });
    });

    it('finds a card by its HMAC without touching it', async () => {
      const account = {
        id: 'acc-1',
        codeHmac: hmacGiftCardCode(SECRET, TENANT, CODE),
        codeHash: null,
      };
      const manager = {
        findOne: jest.fn(() => Promise.resolve(account)),
        query: jest.fn(),
      };
      const found = await keyed.findGiftCardByCode(
        manager as unknown as EntityManager,
        TENANT,
        'abcd efgh 2345 6789',
      );
      expect(found).toBe(account);
      expect(manager.query).not.toHaveBeenCalled();
      const where = (
        manager.findOne.mock.calls[0] as unknown as [
          unknown,
          { where: Record<string, unknown>[] },
        ]
      )[1].where;
      expect(where).toEqual([
        expect.objectContaining({
          tenantId: TENANT,
          codeHmac: account.codeHmac,
        }),
        expect.objectContaining({
          tenantId: TENANT,
          codeHash: legacyHashGiftCardCode(TENANT, CODE),
        }),
      ]);
    });

    it("upgrades a legacy card on lookup, with the caller's manager", async () => {
      const legacy = legacyHashGiftCardCode(TENANT, CODE);
      const account = { id: 'acc-old', codeHmac: null, codeHash: legacy };
      const manager = {
        findOne: jest.fn(() => Promise.resolve(account)),
        query: jest.fn(() => Promise.resolve([])),
      };
      const found = await keyed.findGiftCardByCode(
        manager as unknown as EntityManager,
        TENANT,
        CODE,
      );
      const hmac = hmacGiftCardCode(SECRET, TENANT, CODE);
      expect(manager.query).toHaveBeenCalledTimes(1);
      const [sql, params] = manager.query.mock.calls[0] as unknown as [
        string,
        unknown[],
      ];
      expect(sql).toMatch(/SET "codeHmac" = \$1, "codeHash" = NULL/);
      expect(sql).toMatch(/"codeHash" = \$4/);
      expect(params).toEqual([hmac, 'acc-old', TENANT, legacy]);
      expect(found).toMatchObject({ codeHmac: hmac, codeHash: null });
    });

    it('finds nothing for an unknown code', async () => {
      const manager = {
        findOne: jest.fn(() => Promise.resolve(null)),
        query: jest.fn(),
      };
      await expect(
        keyed.findGiftCardByCode(
          manager as unknown as EntityManager,
          TENANT,
          CODE,
        ),
      ).resolves.toBeNull();
      expect(manager.query).not.toHaveBeenCalled();
    });
  });

  it('gives back what a voided sale spent, net of refunds already made', async () => {
    const db = fakeDb(0);
    db.raw.find.mockResolvedValueOnce([
      { accountId: 'acc-1', type: StoredValueEntryType.REDEEM, amount: -40 },
      {
        accountId: 'acc-1',
        type: StoredValueEntryType.REFUND_CREDIT,
        amount: 15,
      },
    ] as never);
    await service.reverseSaleRedemptions(db.manager, TENANT, 'sale-1', 'Void');
    expect(db.account.balance).toBe(25);
    expect(db.entries[0]).toMatchObject({ type: 'reversal', amount: 25 });
  });

  describe('gift card expiry', () => {
    it('computes the expiry date from the setting (0 = never)', () => {
      const soldAt = new Date('2026-01-31T15:00:00Z');
      expect(giftCardExpiry(soldAt, 0)).toBeNull();
      expect(giftCardExpiry(soldAt, 12)?.toISOString()).toBe(
        '2027-01-31T15:00:00.000Z',
      );
      // No overflow into March
      expect(giftCardExpiry(soldAt, 1)?.toISOString()).toBe(
        '2026-02-28T15:00:00.000Z',
      );
    });

    it('stamps expiresAt on gift cards sold when the store sets a period', async () => {
      const saved: Partial<StoredValueAccount>[] = [];
      const manager = {
        getRepository: () => ({
          exists: jest.fn(() => Promise.resolve(false)),
          create: (data: object) => data,
          save: jest.fn((data: Partial<StoredValueAccount>) => {
            saved.push(data);
            return Promise.resolve({ ...data, id: 'acc-new' });
          }),
        }),
      } as unknown as EntityManager;
      const withSetting = new StoredValueService(
        {} as DataSource,
        audit as unknown as AuditService,
        outbox as unknown as OutboxService,
        {
          getSettings: () => Promise.resolve({ giftCardExpiryMonths: 6 }),
        } as unknown as SettingsService,
      );
      await withSetting.createSaleGiftCards(manager, {
        tenantId: TENANT,
        saleId: 'sale-1',
        currencyCode: 'USD',
        activate: false,
        cards: [{ amount: 50, saleItemId: 'si-1' }],
      });
      const months =
        (saved[0].expiresAt!.getTime() - Date.now()) / (30 * 86_400_000);
      expect(months).toBeGreaterThan(5.8);
      expect(months).toBeLessThan(6.2);
    });

    it('writes off the remaining value of an expired card, audited and published', async () => {
      const db = fakeDb(35);
      db.account.expiresAt = new Date(Date.now() - 1000);
      const dataSource = {
        query: jest.fn(() =>
          Promise.resolve([{ id: 'acc-1', tenantId: TENANT }]),
        ),
        transaction: jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
          work(db.manager),
        ),
      };
      // The row lock read returns the current balance
      db.raw.query.mockImplementationOnce(() =>
        Promise.resolve([{ balance: db.account.balance }] as never),
      );
      const expiring = new StoredValueService(
        dataSource as unknown as DataSource,
        audit as unknown as AuditService,
        outbox as unknown as OutboxService,
      );
      expect(await expiring.expireDue()).toBe(1);
      expect(db.account.balance).toBe(0);
      expect(db.entries).toEqual([
        expect.objectContaining({
          type: StoredValueEntryType.EXPIRE,
          amount: -35,
          balanceAfter: 0,
        }),
      ]);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'stored_value.expire' }),
        db.manager,
      );
      expect(outbox.record).toHaveBeenCalledWith(
        db.manager,
        expect.objectContaining({ type: 'stored_value.changed' }),
      );
      // Spending it is still refused
      await expect(
        expiring.redeem(db.manager, {
          tenantId: TENANT,
          accountId: 'acc-1',
          amount: 1,
          saleId: 's1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('the daily job expires in batches until nothing is due', async () => {
      const expireDue = jest
        .fn()
        .mockResolvedValueOnce(500)
        .mockResolvedValueOnce(3)
        .mockResolvedValueOnce(0);
      const job = new GiftCardExpiryService(
        {} as DataSource,
        { expireDue } as unknown as StoredValueService,
      );
      expect(await job.run()).toBe(503);
      expect(expireDue).toHaveBeenCalledTimes(3);
    });
  });
});

describe('StoredValueService manual credit (second person)', () => {
  const audit = { record: jest.fn() };
  const approvals = { verify: jest.fn() };
  const user = { id: 'user-1', tenantId: TENANT };

  function setup(balance = 0) {
    const db = fakeDb(balance);
    Object.assign(db.raw, {
      findOneOrFail: jest.fn(() => Promise.resolve({ ...db.account })),
    });
    const dataSource = {
      transaction: jest.fn((cb: (manager: EntityManager) => Promise<unknown>) =>
        cb(db.manager),
      ),
      getRepository: jest.fn(() => ({
        findOne: jest.fn(() => Promise.resolve({ ...db.account })),
        find: jest.fn(() => Promise.resolve([])),
      })),
    };
    const service = new StoredValueService(
      dataSource as unknown as DataSource,
      audit as unknown as AuditService,
      undefined,
      undefined,
      approvals as unknown as ApprovalsService,
    );
    return { db, dataSource, service };
  }

  beforeEach(() => jest.clearAllMocks());

  it('adjusts up to the threshold without an approval', async () => {
    const { db, service } = setup(10);
    await service.adjust(TENANT, 'acc-1', SECOND_PERSON_THRESHOLD, 'Fix', {
      user,
    });
    expect(db.account.balance).toBe(10 + SECOND_PERSON_THRESHOLD);
    expect(approvals.verify).not.toHaveBeenCalled();
  });

  it('never needs an approval to take value off', async () => {
    const { db, service } = setup(1000);
    await service.adjust(TENANT, 'acc-1', -900, 'Fix', { user });
    expect(db.account.balance).toBe(100);
    expect(approvals.verify).not.toHaveBeenCalled();
  });

  it('refuses a large positive adjustment without an approval (approvable 403)', async () => {
    const { db, dataSource, service } = setup(0);
    const call = service.adjust(TENANT, 'acc-1', 500.01, 'Goodwill', { user });
    await expect(call).rejects.toBeInstanceOf(ForbiddenException);
    await expect(call).rejects.toMatchObject({
      response: {
        missingPermissions: ['customers.credit.manage'],
        approvable: true,
      },
    });
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(db.account.balance).toBe(0);
  });

  it('refuses a token that does not verify, or approved by the requester', async () => {
    const { service } = setup(0);
    approvals.verify.mockResolvedValueOnce(null);
    await expect(
      service.adjust(TENANT, 'acc-1', 600, 'Goodwill', {
        user,
        approvalToken: 'bad',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    approvals.verify.mockResolvedValueOnce('user-1');
    await expect(
      service.adjust(TENANT, 'acc-1', 600, 'Goodwill', {
        user,
        approvalToken: 'self',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('accepts a second person approval (comma-separated tokens) and audits the approver', async () => {
    const { db, service } = setup(0);
    approvals.verify
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('manager-1');
    await service.adjust(TENANT, 'acc-1', 750, 'Goodwill', {
      user,
      approvalToken: 'other, good',
    });
    expect(approvals.verify).toHaveBeenNthCalledWith(
      1,
      'other',
      'customers.credit.manage',
      user,
    );
    expect(approvals.verify).toHaveBeenNthCalledWith(
      2,
      'good',
      'customers.credit.manage',
      user,
    );
    expect(db.account.balance).toBe(750);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'stored_value.adjustment',
        entityId: 'acc-1',
        approverId: 'manager-1',
        metadata: expect.objectContaining({
          amount: 750,
          approverId: 'manager-1',
        }) as unknown,
      }),
      db.manager,
    );
  });

  it('store credit above the threshold needs a second person too', async () => {
    const { db, service } = setup(0);
    await expect(
      service.creditCustomer(TENANT, 'cust-1', 501, 'Goodwill', 'USD', {
        user,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.account.balance).toBe(0);

    approvals.verify.mockResolvedValueOnce('manager-1');
    await service.creditCustomer(TENANT, 'cust-1', 501, 'Goodwill', 'USD', {
      user,
      approvalToken: 'good',
    });
    expect(db.account.balance).toBe(501);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ approverId: 'manager-1' }),
      db.manager,
    );
  });

  it('fails closed when approvals are not available', async () => {
    const db = fakeDb(0);
    const service = new StoredValueService(
      { transaction: jest.fn() } as unknown as DataSource,
      audit as unknown as AuditService,
    );
    await expect(
      service.adjust(TENANT, 'acc-1', 1000, 'Goodwill', {
        user,
        approvalToken: 'good',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.account.balance).toBe(0);
  });
});
