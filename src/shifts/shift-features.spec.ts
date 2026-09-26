import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  DataSource,
  EntityManager,
  QueryFailedError,
  Repository,
} from 'typeorm';
import { Shift, ShiftStatus } from '../database/entities/shift.entity';
import {
  CashMovement,
  CashMovementType,
} from '../database/entities/cash-movement.entity';
import { CashDenominationSet } from '../database/entities/cash-denomination-set.entity';
import {
  DrawerPolicy,
  Register,
  RegisterStatus,
} from '../database/entities/register.entity';
import { Drawer, DrawerStatus } from '../database/entities/drawer.entity';
import {
  ShiftCorrection,
  ShiftCorrectionType,
} from '../database/entities/shift-correction.entity';
import { ConflictCaseType } from '../database/entities/conflict-case.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import type { AuditService } from '../audit/audit.service';
import type { ApprovalsService } from '../approvals/approvals.service';
import type { SettingsService } from '../settings/settings.service';
import type { DeliveredEvent } from '../events/event-types';
import { ShiftsService, summarizeCorrections } from './shifts.service';
import { expectedCash } from './shift-math';
import { businessDateOf } from './business-date';
import { ShiftEventsConsumer } from './shift-events.consumer';

jest.mock('../common/utils/sequence', () => ({
  nextDocumentNumber: jest.fn(() => Promise.resolve('SH-000002')),
}));

const TENANT = 'tenant-1';
const cashier = {
  id: 'cashier-1',
  permissions: ['shifts.operate'],
} as unknown as AuthUser;
const other = {
  id: 'cashier-2',
  permissions: ['shifts.operate'],
} as unknown as AuthUser;
const manager = {
  id: 'manager-1',
  permissions: ['shifts.operate', 'shifts.manage'],
} as unknown as AuthUser;

const register = Object.assign(new Register(), {
  id: 'reg-1',
  tenantId: TENANT,
  branchId: 'branch-1',
  name: 'Till 1',
  status: RegisterStatus.ACTIVE,
  drawerPolicy: DrawerPolicy.ASSIGNED,
});
const drawer = Object.assign(new Drawer(), {
  id: 'drawer-1',
  tenantId: TENANT,
  registerId: 'reg-1',
  code: 'MAIN',
  name: 'Main drawer',
  status: DrawerStatus.ACTIVE,
});

function makeShift(overrides: Partial<Shift> = {}): Shift {
  return Object.assign(new Shift(), {
    id: 'shift-1',
    tenantId: TENANT,
    shiftNumber: 'SH-000001',
    registerId: 'reg-1',
    drawerId: 'drawer-1',
    branchId: 'branch-1',
    shared: false,
    status: ShiftStatus.OPEN,
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

/**
 * The 69.80 drawer: float 100, one cash sale of 19.80 paid with 20.00 (0.20
 * change), a safe drop of 50. The per-sale ledger row (19.80) and a no-sale
 * opening exist too and must not change the expected cash.
 */
const MOVEMENTS = [
  { type: CashMovementType.SALE, total: 19.8 },
  { type: CashMovementType.NO_SALE, total: 0 },
  { type: CashMovementType.SAFE_DROP, total: 50 },
];

function setup(
  options: {
    shift?: Shift;
    active?: Shift | null;
    register?: Register;
    corrections?: Record<string, unknown>[];
  } = {},
) {
  const shift = options.shift ?? makeShift();
  const savedShifts: Shift[] = [];
  const savedMovements: Partial<CashMovement>[] = [];
  const savedCorrections: Partial<ShiftCorrection>[] = [];
  const sqls: { sql: string; params: unknown[] }[] = [];

  const shiftRepo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) => {
      if (where.previousShiftId) return Promise.resolve(null);
      if (where.drawerId && !where.id) {
        return Promise.resolve(options.active ?? null);
      }
      return Promise.resolve(shift);
    }),
    find: jest.fn(() => Promise.resolve([])),
    create: jest.fn((v: Partial<Shift>) => Object.assign(new Shift(), v)),
    save: jest.fn((s: Shift) => {
      savedShifts.push({ ...s });
      if (!s.id) s.id = 'shift-2';
      return Promise.resolve(s);
    }),
  };
  const movementRepo = {
    find: jest.fn(() => Promise.resolve([])),
    findOne: jest.fn(() => Promise.resolve(null)),
    create: jest.fn((v: Partial<CashMovement>) => v),
    save: jest.fn((v: CashMovement) => {
      savedMovements.push(v);
      return Promise.resolve({ ...v, id: 'mv-1', createdAt: new Date() });
    }),
  };
  const correctionRepo = {
    create: jest.fn((v: Partial<ShiftCorrection>) => v),
    save: jest.fn((v: ShiftCorrection) => {
      savedCorrections.push(v);
      return Promise.resolve({ ...v, id: 'corr-1' });
    }),
  };
  const drawerRepo = {
    findOne: jest.fn(() => Promise.resolve(drawer)),
    findOneOrFail: jest.fn(() => Promise.resolve(drawer)),
    find: jest.fn(() => Promise.resolve([drawer])),
  };
  const registerRepo = {
    findOne: jest.fn(() => Promise.resolve(options.register ?? register)),
    findOneOrFail: jest.fn(() => Promise.resolve(options.register ?? register)),
  };
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    sqls.push({ sql, params });
    if (sql.includes('information_schema')) return Promise.resolve([{}]);
    if (sql.includes('INSERT INTO cash_movements')) return Promise.resolve([]);
    if (sql.includes('FULL JOIN change')) return Promise.resolve([]);
    if (sql.includes('tendered'))
      return Promise.resolve([{ tendered: 20, change: 0.2 }]);
    if (sql.includes('FROM cash_movements')) {
      // Honour the exclusion the service asks for (like Postgres would)
      const excluded = (params[2] as string[] | undefined) ?? [];
      return Promise.resolve(
        MOVEMENTS.filter((m) => !excluded.includes(m.type)),
      );
    }
    if (sql.includes('FROM shift_corrections'))
      return Promise.resolve(options.corrections ?? []);
    if (sql.includes('FROM users')) return Promise.resolve([]);
    if (sql.includes('tenant_memberships'))
      return Promise.resolve([{ id: other.id }]);
    return Promise.resolve([]);
  });
  const getRepository = jest.fn((entity: unknown) => {
    if (entity === Shift) return shiftRepo;
    if (entity === CashMovement) return movementRepo;
    if (entity === ShiftCorrection) return correctionRepo;
    if (entity === Drawer) return drawerRepo;
    if (entity === Register) return registerRepo;
    return { findOne: jest.fn(() => Promise.resolve({ timezone: 'UTC' })) };
  });
  const em = { getRepository, query } as unknown as EntityManager;
  const transaction = jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
    cb(em),
  );
  const dataSource = {
    manager: em,
    query,
    transaction,
    getRepository,
  } as unknown as DataSource;
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const settings = {
    getSettings: jest.fn(() =>
      Promise.resolve({
        shiftVarianceTolerance: 5,
        currencyCode: 'USD',
        businessDayCutoffHour: 0,
      }),
    ),
  };
  const service = new ShiftsService(
    shiftRepo as unknown as Repository<Shift>,
    movementRepo as unknown as Repository<CashMovement>,
    {} as Repository<CashDenominationSet>,
    dataSource,
    audit as unknown as AuditService,
    { verify: jest.fn() } as unknown as ApprovalsService,
    settings as unknown as SettingsService,
  );
  const actions = () =>
    (audit.record.mock.calls as unknown as [{ action: string }][]).map(
      ([entry]) => entry.action,
    );
  return {
    service,
    shift,
    savedShifts,
    savedMovements,
    savedCorrections,
    sqls,
    audit,
    actions,
    dataSource,
    transaction,
  };
}

function uniqueViolation(constraint: string) {
  return new QueryFailedError('INSERT', [], {
    code: '23505',
    constraint,
  } as unknown as Error);
}

describe('drawer policy', () => {
  it('opens a shift on the register drawer with its business date', async () => {
    const { service, savedShifts } = setup();
    await service.open(TENANT, cashier, {
      registerId: 'reg-1',
      openingFloat: 100,
    });
    const created = savedShifts.find((s) => s.shiftNumber === 'SH-000002');
    expect(created).toMatchObject({
      drawerId: 'drawer-1',
      shared: false,
      openingFloat: 100,
      openedById: cashier.id,
    });
    expect(created?.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('assigned: a second shift on the same drawer is refused', async () => {
    const running = makeShift();
    const { service, transaction } = setup({ active: running });
    transaction.mockRejectedValueOnce(
      uniqueViolation('uq_shift_drawer_active'),
    );
    await expect(
      service.open(TENANT, other, { registerId: 'reg-1', openingFloat: 50 }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('shared: the second cashier joins the running shift instead', async () => {
    const running = makeShift({ shared: true });
    const { service, transaction, actions } = setup({
      active: running,
      shift: running,
      register: Object.assign(new Register(), register, {
        drawerPolicy: DrawerPolicy.SHARED,
      }),
    });
    const result = await service.open(TENANT, other, {
      registerId: 'reg-1',
      openingFloat: 50,
    });
    expect(result).toMatchObject({ id: 'shift-1', joined: true, shared: true });
    expect(transaction).not.toHaveBeenCalled();
    expect(actions()).toContain('shift.joined');
  });
});

describe('no-sale drawer open', () => {
  it('records a 0-amount no_sale movement with its reason, audited', async () => {
    const { service, savedMovements, audit } = setup();
    const movement = await service.drawerOpen(TENANT, cashier, 'shift-1', {
      reason: 'Change for a customer',
    });
    expect(movement).toMatchObject({
      type: CashMovementType.NO_SALE,
      amount: 0,
      reason: 'Change for a customer',
    });
    expect(savedMovements[0]).toMatchObject({ type: 'no_sale', amount: 0 });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cash_movement.no_sale',
        reason: 'Change for a customer',
      }),
      expect.anything(),
    );
  });

  it('needs a reason and an open shift', async () => {
    const { service } = setup();
    await expect(
      service.drawerOpen(TENANT, cashier, 'shift-1', { reason: ' ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const closed = setup({
      shift: makeShift({ status: ShiftStatus.CLOSED }),
    });
    await expect(
      closed.service.drawerOpen(TENANT, cashier, 'shift-1', {
        reason: 'Check',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('per-sale cash ledger', () => {
  it('keeps sale and no-sale movements out of the expected cash (69.80)', async () => {
    const { service, dataSource, sqls } = setup();
    const breakdown = await service.computeBreakdown(
      dataSource.manager,
      makeShift(),
    );
    expect(breakdown).toMatchObject({
      openingFloat: 100,
      cashSales: 20,
      changeGiven: 0.2,
      safeDrops: 50,
    });
    expect(expectedCash(breakdown)).toBe(69.8);
    const movementSql = sqls.find((q) => q.sql.includes('FROM cash_movements'));
    expect(movementSql?.params[2]).toEqual(['sale', 'no_sale']);
  });

  function saleEvent(): DeliveredEvent<'sale.completed'> {
    return {
      id: 'evt-1',
      tenantId: TENANT,
      eventType: 'sale.completed',
      aggregateType: 'sale',
      aggregateId: 'sale-1',
      aggregateVersion: null,
      schemaVersion: 1,
      payload: {
        saleId: 'sale-1',
        saleNumber: 'S-000001',
        registerId: 'reg-1',
        shiftId: 'shift-1',
        total: 19.8,
        currencyCode: 'USD',
        lines: [],
      },
      correlationId: null,
      actorId: cashier.id,
      occurredAt: new Date(),
      attempts: 0,
    };
  }

  it('records the net cash of a sale once (idempotent per sale)', async () => {
    const audit = { record: jest.fn(() => Promise.resolve()) };
    const consumer = new ShiftEventsConsumer(audit as unknown as AuditService);
    // Postgres: the first insert returns the row, a replay hits uq_cash_movement_source
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { id: 'mv-9', shiftId: 'shift-1', sourceId: 'sale-1', amount: '19.80' },
      ])
      .mockResolvedValueOnce([]);
    const em = { query } as unknown as EntityManager;

    await consumer.recordSaleCash(saleEvent(), em);
    await consumer.recordSaleCash(saleEvent(), em);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(`'sale'`);
    expect(sql).toContain('ON CONFLICT ("tenantId", "sourceType", "sourceId")');
    expect(sql).toContain('"changeAmount"');
    expect(params).toEqual([
      TENANT,
      expect.any(Array),
      expect.any(Array),
      'sale-1',
    ]);
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'cash_movement.sale',
        metadata: expect.objectContaining({
          amount: 19.8,
          saleId: 'sale-1',
        }) as unknown,
      }),
      em,
    );
  });

  describe('late shift cases', () => {
    function lateSetup(recordedAt: string) {
      const audit = { record: jest.fn(() => Promise.resolve()) };
      const consumer = new ShiftEventsConsumer(
        audit as unknown as AuditService,
      );
      const saved: Record<string, unknown>[] = [];
      const query = jest.fn((sql: string) => {
        if (sql.includes('FROM conflict_cases')) return Promise.resolve([]);
        return Promise.resolve([
          {
            id: 'sale-1',
            saleNumber: 'S-000001',
            deviceId: 'dev-1',
            recordedAt,
            total: 19.8,
            currencyCode: 'USD',
            net: '19.80',
            shiftId: 'shift-1',
            shiftNumber: 'SH-000001',
            status: 'closed',
            closedAt: '2026-09-24T17:00:00Z',
          },
        ]);
      });
      const em = {
        query,
        create: jest.fn((_entity: unknown, v: Record<string, unknown>) => v),
        save: jest.fn((v: Record<string, unknown>) => {
          saved.push(v);
          return Promise.resolve({ ...v, id: 'case-1' });
        }),
      } as unknown as EntityManager;
      return { consumer, em, saved, audit };
    }

    it('opens a late_shift case for a sale recorded after its shift closed', async () => {
      const { consumer, em, saved, audit } = lateSetup('2026-09-24T19:00:00Z');
      await consumer.openLateShiftCase(saleEvent(), em);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        type: ConflictCaseType.LATE_SHIFT,
        saleId: 'sale-1',
        deviceId: 'dev-1',
        details: expect.objectContaining({
          shiftNumber: 'SH-000001',
          cash: 19.8,
        }) as unknown,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'conflict_case.opened' }),
        em,
      );
    });

    it('opens nothing when the sale was recorded before the close', async () => {
      const { consumer, em, saved } = lateSetup('2026-09-24T16:00:00Z');
      await consumer.openLateShiftCase(saleEvent(), em);
      expect(saved).toHaveLength(0);
    });
  });
});

describe('handover', () => {
  it('closes and opens the next shift with the counted cash as float', async () => {
    const shift = makeShift({ status: ShiftStatus.CLOSING });
    const { service, savedShifts, savedMovements, actions } = setup({ shift });
    const result = await service.handover(TENANT, cashier, 'shift-1', {
      countedCash: 69.8,
      idempotencyKey: 'handover-key-1',
      handToUserId: other.id,
    });
    const closed = savedShifts.find((s) => s.id === 'shift-1');
    expect(closed).toMatchObject({
      status: ShiftStatus.CLOSED,
      countedCash: 69.8,
      expectedCash: 69.8,
      handedOverToId: other.id,
    });
    const next = savedShifts.find((s) => s.shiftNumber === 'SH-000002');
    expect(next).toMatchObject({
      openedById: other.id,
      openingFloat: 69.8,
      previousShiftId: 'shift-1',
      drawerId: 'drawer-1',
    });
    expect(savedMovements).toContainEqual(
      expect.objectContaining({
        type: CashMovementType.OPENING_FLOAT,
        amount: 69.8,
        userId: other.id,
      }),
    );
    expect(result.nextShift).toMatchObject({ openingFloat: 69.8 });
    expect(actions()).toEqual(
      expect.arrayContaining([
        'shift.closed',
        'shift.opened',
        'shift.handed_over',
      ]),
    );
  });

  it('carries the counted foreign cash over as the next opening foreign float', async () => {
    const shift = makeShift({
      status: ShiftStatus.CLOSING,
      // Opened with 30 EUR from the previous handover, no EUR sales since
      openingForeignCash: [{ currencyCode: 'EUR', amount: 30 }],
    });
    const { service, savedShifts } = setup({ shift });
    const result = await service.handover(TENANT, cashier, 'shift-1', {
      countedCash: 69.8,
      foreignCounts: [{ currencyCode: 'EUR', countedCash: 30 }],
      idempotencyKey: 'handover-key-1',
      handToUserId: other.id,
    });
    const closed = savedShifts.find((s) => s.id === 'shift-1');
    expect(closed?.foreignCash).toEqual([
      expect.objectContaining({
        currencyCode: 'EUR',
        expected: 30,
        counted: 30,
        variance: 0,
      }),
    ]);
    const next = savedShifts.find((s) => s.shiftNumber === 'SH-000002');
    expect(next?.openingForeignCash).toEqual([
      { currencyCode: 'EUR', amount: 30 },
    ]);
    expect(result.nextShift).toMatchObject({
      openingForeignCash: [{ currencyCode: 'EUR', amount: 30 }],
    });
  });

  it('cannot hand over to yourself', async () => {
    const { service } = setup();
    await expect(
      service.handover(TENANT, cashier, 'shift-1', {
        countedCash: 69.8,
        idempotencyKey: 'handover-key-1',
        handToUserId: cashier.id,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('closed-shift corrections', () => {
  const closedAt = new Date('2026-09-24T17:00:00Z');

  it('adds a linked correction to a closed shift only', async () => {
    const open = setup();
    await expect(
      open.service.addCorrection(TENANT, manager, 'shift-1', {
        type: ShiftCorrectionType.EXPECTED,
        amount: -5,
        reason: 'Unrecorded paid-out',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const closed = setup({
      shift: makeShift({
        status: ShiftStatus.CLOSED,
        closedAt,
        expectedCash: 69.8,
        countedCash: 64.8,
        variance: -5,
      }),
      corrections: [
        {
          id: 'corr-1',
          type: 'expected',
          amount: '-5',
          reason: 'Unrecorded paid-out',
          createdAt: '2026-09-25T09:00:00Z',
          createdById: manager.id,
          approvedById: manager.id,
        },
      ],
    });
    const summary = await closed.service.addCorrection(
      TENANT,
      manager,
      'shift-1',
      {
        type: ShiftCorrectionType.EXPECTED,
        amount: -5,
        reason: 'Unrecorded paid-out',
      },
    );
    expect(closed.savedCorrections[0]).toMatchObject({
      shiftId: 'shift-1',
      amount: -5,
      approvedById: manager.id,
    });
    expect(summary).toMatchObject({
      expectedAdjustment: -5,
      expected: 64.8,
      counted: 64.8,
      variance: 0,
    });
    expect(closed.actions()).toContain('shift.correction_added');

    // The Z-report shows it next to the frozen figures
    const report = await closed.service.zReport(TENANT, manager, 'shift-1');
    expect(report.corrections?.corrections).toHaveLength(1);
    expect(report.corrections?.variance).toBe(0);
  });

  it('sums expected and counted corrections', () => {
    const summary = summarizeCorrections(
      [
        {
          id: 'a',
          type: ShiftCorrectionType.EXPECTED,
          amount: -5,
          reason: 'x',
          createdAt: '',
          createdBy: null,
          approvedBy: null,
        },
        {
          id: 'b',
          type: ShiftCorrectionType.COUNTED,
          amount: 2,
          reason: 'recount',
          createdAt: '',
          createdBy: null,
          approvedBy: null,
        },
      ],
      130,
      128,
    );
    expect(summary).toMatchObject({
      expectedAdjustment: -5,
      countedAdjustment: 2,
      expected: 125,
      counted: 130,
      variance: 5,
    });
  });
});

describe('business date', () => {
  // Port-au-Prince is UTC-4 in September
  const at = new Date('2026-09-25T06:30:00Z'); // 02:30 local

  it('uses the branch timezone', () => {
    expect(businessDateOf(at, 'America/Port-au-Prince', 0)).toBe('2026-09-25');
    expect(
      businessDateOf(
        new Date('2026-09-25T02:30:00Z'),
        'America/Port-au-Prince',
      ),
    ).toBe('2026-09-24');
  });

  it('puts sales before the cutoff hour on the previous day', () => {
    expect(businessDateOf(at, 'America/Port-au-Prince', 4)).toBe('2026-09-24');
    expect(
      businessDateOf(
        new Date('2026-09-25T08:30:00Z'),
        'America/Port-au-Prince',
        4,
      ),
    ).toBe('2026-09-25');
  });

  it('falls back to UTC for an unknown timezone', () => {
    expect(businessDateOf(at, 'Not/AZone', 0)).toBe('2026-09-25');
    expect(businessDateOf(at, null, 7)).toBe('2026-09-24');
  });
});
