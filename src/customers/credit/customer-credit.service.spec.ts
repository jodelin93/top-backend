import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../../audit/audit.service';
import { ShiftsService } from '../../shifts/shifts.service';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { ApprovalsService } from '../../approvals/approvals.service';
import { CustomerCreditEntryType } from '../../database/entities/customer-credit-entry.entity';
import { CashMovementType } from '../../database/entities/cash-movement.entity';
import { PaymentMethodType } from '../../database/entities/payment-method.entity';
import type { AuthUser } from '../../auth/strategies/jwt.strategy';
import { CustomerCreditService } from './customer-credit.service';

const TENANT = 'tenant-1';

interface Row {
  id: string;
  type: CustomerCreditEntryType;
  amount: number;
  balanceAfter: number;
  saleId: string | null;
  reversalOfId: string | null;
  dueDate: string | null;
  createdAt: Date;
  customerId: string;
}

/** In-memory customer row, ledger and allocations behind the SQL the service runs */
function fakeDb(
  customer = { currentBalance: 0, creditLimit: 100, creditHold: false },
) {
  const state = { customer: { id: 'cust-1', code: 'CUST-1', ...customer } };
  const entries: Row[] = [];
  const allocations: {
    debitEntryId: string;
    creditEntryId: string;
    amount: number;
  }[] = [];
  let clock = 0;
  const manager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.includes('FROM registers')) {
        return Promise.resolve([{ branchId: 'branch-1' }]);
      }
      if (sql.includes('UPDATE customers')) {
        const [amount, , , skipHold, skipLimit] = params as [
          number,
          string,
          string,
          boolean,
          boolean,
        ];
        const c = state.customer;
        const next = Math.round((c.currentBalance + amount) * 100) / 100;
        if (
          (!skipHold && c.creditHold) ||
          (!skipLimit && next > c.creditLimit)
        ) {
          return Promise.resolve([[], 0]);
        }
        const previous = c.currentBalance;
        c.currentBalance = next;
        return Promise.resolve([
          [{ balance: next, previous, creditLimit: c.creditLimit }],
          1,
        ]);
      }
      if (sql.includes('FROM customer_credit_entries e')) {
        return Promise.resolve(
          entries.map((e) => {
            const used = allocations
              .filter(
                (a) => a.debitEntryId === e.id || a.creditEntryId === e.id,
              )
              .reduce((s, a) => s + a.amount, 0);
            return {
              ...e,
              open: Math.round((Math.abs(e.amount) - used) * 100) / 100,
            };
          }),
        );
      }
      return Promise.resolve([]);
    }),
    findOne: jest.fn(() =>
      Promise.resolve({ ...state.customer, tenantId: TENANT }),
    ),
    find: jest.fn(() => Promise.resolve(entries.map((e) => ({ ...e })))),
    insert: jest.fn((_entity: unknown, rows: typeof allocations) => {
      allocations.push(...rows);
      return Promise.resolve();
    }),
    getRepository: jest.fn(() => ({
      create: (data: object) => data,
      save: jest.fn((data: Omit<Row, 'id' | 'createdAt'>) => {
        const row = {
          ...data,
          id: `e${entries.length + 1}`,
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, clock++)),
        };
        entries.push(row);
        return Promise.resolve(row);
      }),
    })),
  };
  return {
    state,
    entries,
    allocations,
    manager: manager as unknown as EntityManager,
  };
}

describe('CustomerCreditService', () => {
  const audit = { record: jest.fn() };
  const outbox = { record: jest.fn() };
  const shifts = {
    getOpenShift: jest.fn(),
    recordCashMovement: jest.fn(),
  };
  const approvals = { verify: jest.fn() };
  const make = (dataSource: Partial<DataSource> = {}) =>
    new CustomerCreditService(
      dataSource as DataSource,
      audit as unknown as AuditService,
      shifts as unknown as ShiftsService,
      outbox as unknown as OutboxService,
      approvals as unknown as ApprovalsService,
    );

  beforeEach(() => jest.clearAllMocks());

  const charge = (
    service: CustomerCreditService,
    manager: EntityManager,
    amount: number,
    allowOverLimit = false,
    saleId = `sale-${amount}`,
  ) =>
    service.post(manager, {
      tenantId: TENANT,
      customerId: 'cust-1',
      type: CustomerCreditEntryType.CHARGE,
      amount,
      saleId,
      dueDate: '2026-02-01',
      checkCredit: { allowOverLimit },
    });

  it('keeps the balance projection equal to the sum of the ledger', async () => {
    const db = fakeDb({
      currentBalance: 0,
      creditLimit: 500,
      creditHold: false,
    });
    const service = make();
    await charge(service, db.manager, 120.1);
    await service.post(db.manager, {
      tenantId: TENANT,
      customerId: 'cust-1',
      type: CustomerCreditEntryType.PAYMENT,
      amount: -20.2,
    });
    await service.creditNote(db.manager, {
      tenantId: TENANT,
      customerId: 'cust-1',
      saleId: 'sale-120.1',
      returnId: 'ret-1',
      amount: 9.9,
      note: 'Return',
    });
    const sum =
      db.entries.reduce((s, e) => s + Math.round(e.amount * 100), 0) / 100;
    expect(db.state.customer.currentBalance).toBe(90);
    expect(sum).toBe(90);
    expect(db.entries.map((e) => e.balanceAfter)).toEqual([120.1, 99.9, 90]);
  });

  it('refuses a charge above the credit limit with an approvable 403, allows it when approved', async () => {
    const db = fakeDb({
      currentBalance: 80,
      creditLimit: 100,
      creditHold: false,
    });
    const service = make();
    const refused = charge(service, db.manager, 30);
    await expect(refused).rejects.toBeInstanceOf(ForbiddenException);
    await refused.catch((error: ForbiddenException) => {
      expect(error.getResponse()).toMatchObject({
        missingPermissions: ['customers.credit.override'],
        approvable: true,
      });
    });
    expect(db.entries).toHaveLength(0);

    await charge(service, db.manager, 30, true);
    expect(db.state.customer.currentBalance).toBe(110);
  });

  it('refuses any charge while the customer is on credit hold, even approved', async () => {
    const db = fakeDb({
      currentBalance: 0,
      creditLimit: 1000,
      creditHold: true,
    });
    const service = make();
    await expect(charge(service, db.manager, 10, true)).rejects.toThrow(
      'credit hold',
    );
    // Payments are still taken
    await service.post(db.manager, {
      tenantId: TENANT,
      customerId: 'cust-1',
      type: CustomerCreditEntryType.ADJUSTMENT,
      amount: -5,
    });
    expect(db.entries).toHaveLength(1);
  });

  it('settles charges FIFO and never over-allocates', async () => {
    const db = fakeDb({
      currentBalance: 0,
      creditLimit: 1000,
      creditHold: false,
    });
    const service = make();
    await charge(service, db.manager, 30, false, 'sale-a');
    await charge(service, db.manager, 50, false, 'sale-b');
    await service.post(db.manager, {
      tenantId: TENANT,
      customerId: 'cust-1',
      type: CustomerCreditEntryType.PAYMENT,
      amount: -40,
    });
    await service.post(db.manager, {
      tenantId: TENANT,
      customerId: 'cust-1',
      type: CustomerCreditEntryType.PAYMENT,
      amount: -100,
    });
    const byDebit = (id: string) =>
      db.allocations
        .filter((a) => a.debitEntryId === id)
        .reduce((s, a) => s + a.amount, 0);
    expect(byDebit('e1')).toBe(30);
    expect(byDebit('e2')).toBe(50);
    // The second payment only covers the 40 left; 60 stays as unapplied credit
    expect(
      db.allocations
        .filter((a) => a.creditEntryId === 'e4')
        .reduce((s, a) => s + a.amount, 0),
    ).toBe(40);
  });

  it('records the event and the audit entry with the business transaction manager', async () => {
    const db = fakeDb();
    await charge(make(), db.manager, 10);
    expect(outbox.record).toHaveBeenCalledWith(
      db.manager,
      expect.objectContaining({
        type: 'customer.credit_changed',
        aggregateId: 'cust-1',
        payload: expect.objectContaining({
          previousBalance: 0,
          newBalance: 10,
        }) as unknown,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'customer.credit.charge' }),
      db.manager,
    );
  });

  it('reverses what a voided sale still has on account, net of credit notes', async () => {
    const db = fakeDb({
      currentBalance: 0,
      creditLimit: 1000,
      creditHold: false,
    });
    const service = make();
    await charge(service, db.manager, 60, false, 'sale-1');
    await service.creditNote(db.manager, {
      tenantId: TENANT,
      customerId: 'cust-1',
      saleId: 'sale-1',
      returnId: 'ret-1',
      amount: 20,
      note: 'Return',
    });
    await service.reverseSale(db.manager, TENANT, 'sale-1', 'Void');
    const reversal = db.entries.find(
      (e) => e.type === CustomerCreditEntryType.REVERSAL,
    );
    expect(reversal).toMatchObject({ amount: -40, reversalOfId: 'e1' });
    expect(db.state.customer.currentBalance).toBe(0);
  });

  describe('payments on account', () => {
    const user = {
      id: 'user-1',
      tenantId: TENANT,
      permissions: ['customers.credit.receive', 'customers.finance.view'],
    } as AuthUser;
    // A cashier who takes payments but may not see balances
    const cashier = {
      id: 'user-1',
      tenantId: TENANT,
      permissions: ['customers.credit.receive'],
      branchIds: ['branch-1'],
    } as unknown as AuthUser;
    const card = {
      id: 'card',
      code: 'CARD',
      name: { en: 'Card' },
      methodType: PaymentMethodType.CARD,
      status: 'active',
      requiresReference: false,
    };
    const cash = {
      id: 'cash',
      code: 'CASH',
      name: { en: 'Cash' },
      methodType: PaymentMethodType.CASH,
      status: 'active',
      requiresReference: false,
    };

    const setup = (balance: number) => {
      const db = fakeDb({
        currentBalance: balance,
        creditLimit: 500,
        creditHold: false,
      });
      const repos = {
        findOne: jest.fn(
          (options: { where: { idempotencyKey?: string; id?: string } }) =>
            Promise.resolve(
              options.where.idempotencyKey
                ? null
                : options.where.id === 'card'
                  ? card
                  : cash,
            ),
        ),
        findOneOrFail: jest.fn(() => Promise.resolve(db.entries[0])),
      };
      const dataSource = {
        getRepository: jest.fn(() => repos),
        transaction: jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
          work(db.manager),
        ),
        query: jest.fn(() => Promise.resolve([])),
      };
      const service = make(dataSource as unknown as DataSource);
      jest
        .spyOn(service, 'account')
        .mockResolvedValue({ balance: 30 } as never);
      return { db, service };
    };

    it('puts cash into the open shift as a paid-in customer payment', async () => {
      const { db, service } = setup(80);
      shifts.getOpenShift.mockResolvedValue({
        id: 'shift-1',
        openedById: 'user-1',
      });
      await service.recordPayment(TENANT, user, 'cust-1', {
        amount: 50,
        paymentMethodId: 'cash',
        registerId: 'reg-1',
      });
      expect(db.state.customer.currentBalance).toBe(30);
      expect(shifts.recordCashMovement).toHaveBeenCalledWith(
        db.manager,
        expect.objectContaining({
          shiftId: 'shift-1',
          type: CashMovementType.PAID_IN,
          amount: 50,
          sourceType: 'customer_payment',
          sourceId: 'e1',
        }),
      );
    });

    it('refuses a payment larger than what the customer owes', async () => {
      const { service } = setup(20);
      await expect(
        service.recordPayment(TENANT, user, 'cust-1', {
          amount: 25,
          paymentMethodId: 'cash',
          registerId: 'reg-1',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('does not reveal what the customer owes to users without customers.finance.view', async () => {
      const { service } = setup(20);
      const refusal = service.recordPayment(TENANT, cashier, 'cust-1', {
        amount: 25,
        paymentMethodId: 'cash',
        registerId: 'reg-1',
      });
      await expect(refusal).rejects.toThrow(
        "A payment can't be more than what the customer owes",
      );
    });

    it('returns the account only to users who may see balances', async () => {
      shifts.getOpenShift.mockResolvedValue({
        id: 'shift-1',
        openedById: 'user-1',
      });
      const seen = setup(80);
      const full = await seen.service.recordPayment(TENANT, user, 'cust-1', {
        amount: 50,
        paymentMethodId: 'cash',
        registerId: 'reg-1',
      });
      expect(full.account).toEqual({ balance: 30 });
      expect(full.entry.balanceAfter).toBe(30);

      const hidden = setup(80);
      const limited = await hidden.service.recordPayment(
        TENANT,
        cashier,
        'cust-1',
        { amount: 50, paymentMethodId: 'cash', registerId: 'reg-1' },
      );
      expect(limited.account).toBeUndefined();
      expect(limited.entry).not.toHaveProperty('balanceAfter');
      expect(limited.entry.amount).toBe(-50);
    });

    it("never puts cash into another cashier's (non-shared) shift", async () => {
      const { service } = setup(80);
      shifts.getOpenShift.mockResolvedValue({
        id: 'shift-2',
        openedById: 'someone-else',
        shared: false,
      });
      await expect(
        service.recordPayment(TENANT, user, 'cust-1', {
          amount: 50,
          paymentMethodId: 'cash',
          registerId: 'reg-1',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(shifts.recordCashMovement).not.toHaveBeenCalled();

      // A shared drawer takes it
      shifts.getOpenShift.mockResolvedValue({
        id: 'shift-3',
        openedById: 'someone-else',
        shared: true,
      });
      await service.recordPayment(TENANT, user, 'cust-1', {
        amount: 50,
        paymentMethodId: 'cash',
        registerId: 'reg-1',
      });
      expect(shifts.recordCashMovement).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ shiftId: 'shift-3' }),
      );
    });

    it("refuses a register outside the user's branches (404)", async () => {
      const { service } = setup(80);
      shifts.getOpenShift.mockResolvedValue({
        id: 'shift-1',
        openedById: 'user-1',
      });
      await expect(
        service.recordPayment(
          TENANT,
          { ...cashier, branchIds: ['branch-2'] } as unknown as AuthUser,
          'cust-1',
          { amount: 50, paymentMethodId: 'cash', registerId: 'reg-1' },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it("needs a second person's approval for a large non-cash payment", async () => {
      const { db, service } = setup(900);
      const pay = (token?: string) =>
        service.recordPayment(
          TENANT,
          user,
          'cust-1',
          { amount: 600, paymentMethodId: 'card' },
          token,
        );
      await expect(pay()).rejects.toBeInstanceOf(ForbiddenException);
      // An approval of the user's own does not count
      approvals.verify.mockResolvedValueOnce('user-1');
      await expect(pay('own-token')).rejects.toBeInstanceOf(ForbiddenException);
      expect(db.entries).toHaveLength(0);

      approvals.verify.mockResolvedValueOnce('manager-1');
      await pay('manager-token');
      expect(approvals.verify).toHaveBeenLastCalledWith(
        'manager-token',
        'customers.credit.manage',
        user,
      );
      expect(db.entries[0]).toEqual(
        expect.objectContaining({ amount: -600, approverId: 'manager-1' }),
      );
    });

    it('takes a small non-cash payment without approval', async () => {
      const { db, service } = setup(100);
      await service.recordPayment(TENANT, user, 'cust-1', {
        amount: 100,
        paymentMethodId: 'card',
      });
      expect(approvals.verify).not.toHaveBeenCalled();
      expect(db.entries).toHaveLength(1);
    });
  });
});
