import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Shift, ShiftStatus } from '../database/entities/shift.entity';
import {
  CashMovement,
  CashMovementType,
} from '../database/entities/cash-movement.entity';
import { CashDenominationSet } from '../database/entities/cash-denomination-set.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import type { AuditService } from '../audit/audit.service';
import type { ApprovalsService } from '../approvals/approvals.service';
import type { SettingsService } from '../settings/settings.service';
import { ShiftsService } from './shifts.service';

const TENANT = 'tenant-1';
const cashier = {
  id: 'cashier-1',
  permissions: ['shifts.operate'],
} as unknown as AuthUser;
const manager = {
  id: 'manager-1',
  permissions: ['shifts.operate', 'shifts.manage'],
} as unknown as AuthUser;

function makeShift(overrides: Partial<Shift> = {}): Shift {
  return Object.assign(new Shift(), {
    id: 'shift-1',
    tenantId: TENANT,
    shiftNumber: 'SH-000001',
    registerId: 'reg-1',
    status: ShiftStatus.CLOSING,
    currencyCode: 'USD',
    openedById: cashier.id,
    openedAt: new Date('2026-09-24T08:00:00Z'),
    openingFloat: 100,
    blindCount: false,
    closedAt: null,
    closedById: null,
    closeApprovedById: null,
    closeIdempotencyKey: null,
    closingSummary: null,
    closingDenominations: null,
    closingStartedAt: null,
    ...overrides,
  });
}

/** Drawer: float 100 + cash tendered 60 − change 10 − safe drop 20 = 130 expected */
function setup(shift: Shift, approverId: string | null = null) {
  const saved: Shift[] = [];
  const shiftRepo = {
    findOne: jest.fn(() => Promise.resolve(shift)),
    save: jest.fn((s: Shift) => {
      saved.push({ ...s });
      return Promise.resolve(s);
    }),
  };
  const movementRepo = {
    find: jest.fn(() => Promise.resolve([])),
    findOne: jest.fn(() => Promise.resolve(null)),
    create: jest.fn((v: Partial<CashMovement>) => v),
    save: jest.fn((v: CashMovement) => Promise.resolve({ ...v, id: 'mv-1' })),
  };
  const query = jest.fn((sql: string) => {
    if (sql.includes('information_schema')) return Promise.resolve([{}]);
    // No cash taken in other currencies
    if (sql.includes('FULL JOIN change')) return Promise.resolve([]);
    if (sql.includes('tendered'))
      return Promise.resolve([{ tendered: 60, change: 10 }]);
    if (sql.includes('FROM cash_movements'))
      return Promise.resolve([{ type: CashMovementType.SAFE_DROP, total: 20 }]);
    if (sql.includes('FROM users')) return Promise.resolve([]);
    if (sql.includes('GROUP BY pm.id')) return Promise.resolve([]);
    return Promise.resolve([{ count: 0, total: 0 }]);
  });
  const getRepository = jest.fn((entity: unknown) => {
    if (entity === Shift) return shiftRepo;
    if (entity === CashMovement) return movementRepo;
    return { findOne: jest.fn(() => Promise.resolve({ name: 'Till 1' })) };
  });
  const manager = { getRepository, query } as unknown as EntityManager;
  const dataSource = {
    manager,
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager),
    ),
    getRepository,
  } as unknown as DataSource;
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const approvals = { verify: jest.fn(() => Promise.resolve(approverId)) };
  const settings = {
    getSettings: jest.fn(() =>
      Promise.resolve({ shiftVarianceTolerance: 5, currencyCode: 'USD' }),
    ),
  };
  const service = new ShiftsService(
    shiftRepo as unknown as Repository<Shift>,
    movementRepo as unknown as Repository<CashMovement>,
    {} as Repository<CashDenominationSet>,
    dataSource,
    audit as unknown as AuditService,
    approvals as unknown as ApprovalsService,
    settings as unknown as SettingsService,
  );
  return { service, saved, audit, approvals, movementRepo };
}

describe('ShiftsService.close', () => {
  it('computes expected cash and variance, and closes once', async () => {
    const shift = makeShift();
    const { service, saved, audit } = setup(shift);
    const result = await service.close(TENANT, cashier, shift.id, {
      countedCash: 128,
      idempotencyKey: 'close-key-1',
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      status: ShiftStatus.CLOSED,
      expectedCash: 130,
      countedCash: 128,
      variance: -2,
      closedById: cashier.id,
      closeIdempotencyKey: 'close-key-1',
    });
    expect(result.replayed).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'shift.closed' }),
      expect.anything(),
    );
  });

  it('returns the first result for a retried close without posting again', async () => {
    const shift = makeShift({
      status: ShiftStatus.CLOSED,
      closeIdempotencyKey: 'close-key-1',
      variance: -2,
    });
    const { service, saved, audit } = setup(shift);
    const result = await service.close(TENANT, cashier, shift.id, {
      countedCash: 999,
      idempotencyKey: 'close-key-1',
    });
    expect(result.replayed).toBe(true);
    expect(result.variance).toBe(-2);
    expect(saved).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects closing an already closed shift with another key', async () => {
    const shift = makeShift({
      status: ShiftStatus.CLOSED,
      closeIdempotencyKey: 'close-key-1',
    });
    const { service } = setup(shift);
    await expect(
      service.close(TENANT, cashier, shift.id, {
        countedCash: 130,
        idempotencyKey: 'close-key-2',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('needs a reason and a manager approval above the tolerance', async () => {
    const shift = makeShift();
    const { service, saved } = setup(shift);
    await expect(
      service.close(TENANT, cashier, shift.id, {
        countedCash: 100,
        idempotencyKey: 'close-key-1',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.close(TENANT, cashier, shift.id, {
        countedCash: 100,
        idempotencyKey: 'close-key-1',
        varianceReason: 'short',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(saved).toHaveLength(0);
  });

  it('accepts a manager approval token and records the approver', async () => {
    const shift = makeShift();
    const { service, saved } = setup(shift, manager.id);
    await service.close(
      TENANT,
      cashier,
      shift.id,
      {
        countedCash: 100,
        idempotencyKey: 'close-key-1',
        varianceReason: 'short',
      },
      'token',
    );
    expect(saved[0]).toMatchObject({
      variance: -30,
      closeApprovedById: manager.id,
      varianceReason: 'short',
    });
  });

  it('lets a manager force-close someone else’s shift', async () => {
    const shift = makeShift({ status: ShiftStatus.OPEN });
    const { service, saved } = setup(shift);
    await service.close(TENANT, manager, shift.id, {
      countedCash: 130,
      idempotencyKey: 'close-key-1',
    });
    expect(saved[0]).toMatchObject({ forceClosed: true, variance: 0 });
  });

  it('forbids a cashier closing someone else’s shift', async () => {
    const shift = makeShift({ openedById: 'someone-else' });
    const { service } = setup(shift);
    await expect(
      service.close(TENANT, cashier, shift.id, {
        countedCash: 130,
        idempotencyKey: 'close-key-1',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ShiftsService.recordCashMovement', () => {
  it('refuses to post to a closed shift', async () => {
    const shift = makeShift({ status: ShiftStatus.CLOSED });
    const { service } = setup(shift);
    const { manager: m } = (service as unknown as { dataSource: DataSource })
      .dataSource;
    await expect(
      service.recordCashMovement(m, {
        tenantId: TENANT,
        shiftId: shift.id,
        type: CashMovementType.REFUND,
        amount: 5,
        userId: cashier.id,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns the existing movement for an expense already posted', async () => {
    const shift = makeShift({ status: ShiftStatus.OPEN });
    const { service, movementRepo } = setup(shift);
    const existing = { id: 'mv-existing', expenseId: 'exp-1' };
    movementRepo.findOne.mockResolvedValueOnce(existing as never);
    const { manager: m } = (service as unknown as { dataSource: DataSource })
      .dataSource;
    const result = await service.recordCashMovement(m, {
      tenantId: TENANT,
      shiftId: shift.id,
      type: CashMovementType.EXPENSE,
      amount: 5,
      userId: cashier.id,
      expenseId: 'exp-1',
    });
    expect(result).toBe(existing);
    expect(movementRepo.save).not.toHaveBeenCalled();
  });
});

describe('ShiftsService closed shifts are frozen', () => {
  const closedAt = new Date('2026-09-24T17:00:00Z');
  const frozen = {
    final: true,
    shift: { id: 'shift-1', shiftNumber: 'SH-000001' },
    sales: {
      count: 3,
      total: 60,
      voidedCount: 0,
      voidedTotal: 0,
      byPaymentMethod: [],
    },
    cash: {
      openingFloat: 100,
      cashSales: 60,
      changeGiven: 10,
      paidIn: 0,
      paidOut: 0,
      safeDrops: 20,
      expensePayouts: 0,
      cashRefunds: 0,
      foreign: [],
      expected: 130,
    },
  };

  /** Sales queries answer as if one offline sale (cash 25) arrived after the close */
  function withLateSale(service: ShiftsService) {
    const { manager: m } = (service as unknown as { dataSource: DataSource })
      .dataSource;
    const { query } = m as unknown as { query: jest.Mock };
    const sqls: string[] = [];
    query.mockImplementation((sql: string) => {
      sqls.push(sql);
      if (sql.includes('information_schema')) return Promise.resolve([{}]);
      if (sql.includes('FULL JOIN change')) return Promise.resolve([]);
      if (sql.includes('tendered'))
        return Promise.resolve([{ tendered: 30, change: 5 }]);
      if (sql.includes('GROUP BY 1 ORDER BY 1'))
        return Promise.resolve([
          { currencyCode: 'USD', count: '1', total: 25 },
        ]);
      if (sql.includes('"uploadedAt"'))
        return Promise.resolve([
          {
            id: 'sale-late',
            saleNumber: 'S-000099',
            saleDate: '2026-09-24T16:30:00Z',
            uploadedAt: '2026-09-24T19:00:00Z',
            total: 25,
            currencyCode: 'USD',
          },
        ]);
      return Promise.resolve([]);
    });
    return sqls;
  }

  it('serves the frozen figures and lists late uploads separately', async () => {
    const shift = makeShift({
      status: ShiftStatus.CLOSED,
      closedAt,
      expectedCash: 130,
      countedCash: 130,
      variance: 0,
      closingSummary: frozen as unknown as Record<string, unknown>,
    });
    const { service } = setup(shift);
    const sqls = withLateSale(service);

    const detail = await service.findOne(TENANT, cashier, shift.id);

    expect(detail.cash).toEqual(frozen.cash);
    expect(detail.sales).toEqual(frozen.sales);
    expect(detail.lateSales).toMatchObject({
      count: 1,
      cash: 25,
      byCurrency: [{ currencyCode: 'USD', count: 1, total: 25 }],
      sales: [
        { saleNumber: 'S-000099', uploadedAt: '2026-09-24T19:00:00.000Z' },
      ],
    });
    // Late sales are those recorded after the close
    const late = sqls.filter((sql) => sql.includes('s.created_at > $4'));
    expect(late.length).toBeGreaterThan(0);
  });

  it('keeps the Z-report frozen and adds the late-upload supplement', async () => {
    const shift = makeShift({
      status: ShiftStatus.CLOSED,
      closedAt,
      closingSummary: frozen as unknown as Record<string, unknown>,
    });
    const { service } = setup(shift);
    withLateSale(service);

    const report = await service.zReport(TENANT, cashier, shift.id);

    expect(report.cash.expected).toBe(130);
    expect(report.sales.total).toBe(60);
    expect(report.lateSales?.count).toBe(1);
  });

  it('rebuilds a closed shift without a stored summary from sales recorded before the close', async () => {
    const shift = makeShift({
      status: ShiftStatus.CLOSED,
      closedAt,
      expectedCash: 130,
      countedCash: 128,
      variance: -2,
    });
    const { service } = setup(shift);
    const sqls = withLateSale(service);

    const report = await service.zReport(TENANT, cashier, shift.id);

    // Stored expected cash wins over a recomputation
    expect(report.cash.expected).toBe(130);
    expect(report.variance).toMatchObject({ counted: 128, variance: -2 });
    const scoped = sqls.filter(
      (sql) => sql.includes('FROM sales s WHERE') && !sql.includes('> $4'),
    );
    expect(scoped.length).toBeGreaterThan(0);
    for (const sql of scoped) expect(sql).toContain('s.created_at <= $4');
  });

  it('has no late-sales supplement while the shift is open', async () => {
    const shift = makeShift({ status: ShiftStatus.OPEN });
    const { service } = setup(shift);
    const detail = await service.findOne(TENANT, cashier, shift.id);
    expect(detail.lateSales).toBeNull();
  });
});
