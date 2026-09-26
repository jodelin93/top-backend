import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager, FindOperator } from 'typeorm';
import { Employee, EmployeeStatus } from '../database/entities/employee.entity';
import { EmployeeBranch } from '../database/entities/employee-branch.entity';
import { EmployeeAttendance } from '../database/entities/employee-attendance.entity';
import { Branch } from '../database/entities/branch.entity';
import {
  MembershipStatus,
  TenantMembership,
} from '../database/entities/tenant-membership.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import type { AuditService } from '../audit/audit.service';
import type { UsersService } from '../users/users.service';
import { EmployeesService } from './employees.service';
import { spanHours, totalHours } from './attendance-math';

const TENANT = 'tenant-1';
const admin = {
  id: 'admin-1',
  permissions: ['employees.manage', 'users.manage'],
} as unknown as AuthUser;
const manager = {
  id: 'manager-1',
  permissions: ['employees.manage'],
} as unknown as AuthUser;
const cashier = {
  id: 'user-2',
  permissions: ['pos.sell'],
} as unknown as AuthUser;
// Branch-limited users (tenant_memberships."branchIds")
const branchManager = {
  id: 'manager-a',
  permissions: ['employees.manage', 'users.manage'],
  branchIds: ['branch-a'],
} as unknown as AuthUser;
const cashierAtA = { ...cashier, branchIds: ['branch-a'] } as AuthUser;
const SCOPE_A = ['branch-a'];

type Row = Record<string, unknown>;

/** Enough of a TypeORM repository over an in-memory table for the service */
function fakeRepo(rows: Row[]) {
  const matches = (row: Row, where: Row = {}) =>
    Object.entries(where).every(([key, expected]) => {
      if (expected instanceof FindOperator) {
        if (expected.type === 'isNull') return row[key] == null;
        if (expected.type === 'in') {
          return (expected.value as unknown[]).includes(row[key]);
        }
        throw new Error(`unsupported operator ${expected.type}`);
      }
      return row[key] === expected;
    });
  // Query builder stub: records the conditions, returns no rows
  const conditions: [string, Row | undefined][] = [];
  const qb: Record<string, unknown> = {};
  for (const method of [
    'leftJoinAndSelect',
    'innerJoinAndSelect',
    'leftJoin',
    'addSelect',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
  ]) {
    qb[method] = () => qb;
  }
  qb.where = qb.andWhere = (sql: string, params?: Row) => {
    conditions.push([sql, params]);
    return qb;
  };
  qb.getManyAndCount = () => Promise.resolve([[], 0]);
  qb.getMany = () => Promise.resolve([]);
  const repo = {
    rows,
    conditions,
    createQueryBuilder: jest.fn(() => qb),
    create: (value: Row) => ({ ...value }),
    findOne: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
    ),
    find: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(rows.filter((r) => matches(r, where))),
    ),
    count: jest.fn(({ where }: { where: Row }) =>
      Promise.resolve(rows.filter((r) => matches(r, where)).length),
    ),
    save: jest.fn((value: Row | Row[]) => {
      const list = Array.isArray(value) ? value : [value];
      for (const item of list) {
        if (!item.id) item.id = randomUUID();
        const existing = rows.find((r) => r.id === item.id);
        if (existing) Object.assign(existing, item);
        else rows.push({ ...item });
      }
      return Promise.resolve(value);
    }),
    update: jest.fn((where: Row, patch: Row) => {
      rows
        .filter((r) => matches(r, where))
        .forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ affected: 1 });
    }),
    delete: jest.fn((where: Row) => {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (matches(rows[i], where)) rows.splice(i, 1);
      }
      return Promise.resolve({ affected: 1 });
    }),
  };
  return repo;
}

function setup() {
  const tables = new Map<unknown, ReturnType<typeof fakeRepo>>([
    [Employee, fakeRepo([])],
    [EmployeeBranch, fakeRepo([])],
    [EmployeeAttendance, fakeRepo([])],
    [
      Branch,
      fakeRepo([
        { id: 'branch-a', tenantId: TENANT },
        { id: 'branch-b', tenantId: TENANT },
      ]),
    ],
    [
      TenantMembership,
      fakeRepo([
        { tenantId: TENANT, userId: 'user-2', status: MembershipStatus.ACTIVE },
        { tenantId: TENANT, userId: 'user-3', status: MembershipStatus.ACTIVE },
      ]),
    ],
  ]);
  const getRepository = jest.fn((entity: unknown) => {
    const repo = tables.get(entity);
    if (!repo) throw new Error('unexpected repository');
    return repo;
  });
  const query = jest.fn((sql: string, params: unknown[]) => {
    if (sql.includes('FROM users')) {
      return Promise.resolve([
        { id: params[0], email: `${String(params[0])}@shop.test` },
      ]);
    }
    return Promise.resolve([]);
  });
  const em = { getRepository, query } as unknown as EntityManager;
  const dataSource = {
    manager: em,
    getRepository,
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(em),
    ),
  } as unknown as DataSource;
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const users = { update: jest.fn(() => Promise.resolve({})) };
  const service = new EmployeesService(
    dataSource,
    audit as unknown as AuditService,
    users as unknown as UsersService,
  );
  const table = (entity: unknown) => tables.get(entity)!.rows;
  const conditions = (entity: unknown) => tables.get(entity)!.conditions;
  const actions = () =>
    (audit.record.mock.calls as unknown as [{ action: string }][]).map(
      ([entry]) => entry.action,
    );
  return { service, table, conditions, audit, users, actions };
}

describe('EmployeesService', () => {
  it('creates an employee with branch assignments (first one primary)', async () => {
    const { service, table, actions } = setup();
    const created = await service.create(TENANT, {
      firstName: ' Marie ',
      lastName: 'Joseph',
      employeeCode: 'E-01',
      branches: [{ branchId: 'branch-a' }, { branchId: 'branch-b' }],
    });
    expect(created).toMatchObject({
      name: 'Marie Joseph',
      status: EmployeeStatus.ACTIVE,
      employeeCode: 'E-01',
      userId: null,
    });
    expect(created.branches).toEqual([
      { branchId: 'branch-a', isPrimary: true },
      { branchId: 'branch-b', isPrimary: false },
    ]);
    expect(table(EmployeeBranch)).toHaveLength(2);
    expect(actions()).toContain('employee.created');
  });

  it('rejects two primary branches and unknown branches', async () => {
    const { service } = setup();
    await expect(
      service.create(TENANT, {
        firstName: 'A',
        lastName: 'B',
        branches: [
          { branchId: 'branch-a', isPrimary: true },
          { branchId: 'branch-b', isPrimary: true },
        ],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(TENANT, {
        firstName: 'A',
        lastName: 'B',
        branches: [{ branchId: 'nowhere' }],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updates fields and replaces the branch assignments', async () => {
    const { service, table, actions } = setup();
    const { id } = await service.create(TENANT, {
      firstName: 'Marie',
      lastName: 'Joseph',
      branches: [{ branchId: 'branch-a' }],
    });
    const updated = await service.update(TENANT, id, {
      jobTitle: 'Cashier',
      branches: [{ branchId: 'branch-b', isPrimary: true }],
    });
    expect(updated.jobTitle).toBe('Cashier');
    expect(updated.branches).toEqual([
      { branchId: 'branch-b', isPrimary: true },
    ]);
    expect(table(EmployeeBranch)).toHaveLength(1);
    expect(actions()).toContain('employee.updated');

    await service.assignBranches(TENANT, id, [
      { branchId: 'branch-a' },
      { branchId: 'branch-b', isPrimary: true },
    ]);
    expect(
      table(EmployeeBranch).find((b) => b.branchId === 'branch-b')?.isPrimary,
    ).toBe(true);
    expect(actions()).toContain('employee.branches_assigned');
  });

  it('links a member account once and unlinks it', async () => {
    const { service, actions } = setup();
    const a = await service.create(TENANT, { firstName: 'A', lastName: 'One' });
    const b = await service.create(TENANT, { firstName: 'B', lastName: 'Two' });

    const linked = await service.linkUser(TENANT, a.id, 'user-2');
    expect(linked.userId).toBe('user-2');
    expect(linked.user?.email).toBe('user-2@shop.test');
    expect(actions()).toContain('employee.user_linked');

    // Same login on a second employee, or a stranger's account: refused
    await expect(
      service.linkUser(TENANT, b.id, 'user-2'),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.linkUser(TENANT, b.id, 'not-a-member'),
    ).rejects.toBeInstanceOf(BadRequestException);

    const unlinked = await service.unlinkUser(TENANT, a.id);
    expect(unlinked.userId).toBeNull();
    expect(actions()).toContain('employee.user_unlinked');
  });

  it('deactivating a linked employee suspends the login (users.manage) and ends the open clock-in', async () => {
    const { service, users, table, actions } = setup();
    const e = await service.create(TENANT, {
      firstName: 'A',
      lastName: 'One',
      userId: 'user-2',
    });
    table(EmployeeAttendance).push({
      id: 'att-1',
      tenantId: TENANT,
      employeeId: e.id,
      clockIn: new Date('2026-09-24T08:00:00Z'),
      clockOut: null,
    });

    // Without users.manage the login cannot be suspended: nothing changes
    await expect(
      service.deactivate(TENANT, manager, e.id, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(users.update).not.toHaveBeenCalled();

    const result = await service.deactivate(TENANT, admin, e.id, {
      terminationDate: '2026-09-25',
      reason: 'Left the company',
    });
    expect(users.update).toHaveBeenCalledWith(TENANT, admin, 'user-2', {
      status: MembershipStatus.SUSPENDED,
    });
    expect(result).toMatchObject({
      status: EmployeeStatus.INACTIVE,
      terminationDate: '2026-09-25',
    });
    expect(table(EmployeeAttendance)[0].clockOut).toBeInstanceOf(Date);
    expect(actions()).toContain('employee.deactivated');

    const back = await service.reactivate(TENANT, e.id);
    expect(back.status).toBe(EmployeeStatus.ACTIVE);
  });

  it('deactivates an employee without a login with employees.manage only', async () => {
    const { service, users } = setup();
    const e = await service.create(TENANT, { firstName: 'A', lastName: 'One' });
    const result = await service.deactivate(TENANT, manager, e.id, {});
    expect(result.status).toBe(EmployeeStatus.INACTIVE);
    expect(users.update).not.toHaveBeenCalled();
  });

  it('clocks the signed-in user in and out at the till', async () => {
    const { service, table, actions } = setup();
    await expect(
      service.clock(TENANT, cashier, { action: 'in' }),
    ).rejects.toBeInstanceOf(NotFoundException);

    const e = await service.create(TENANT, {
      firstName: 'A',
      lastName: 'One',
      userId: 'user-2',
      branches: [{ branchId: 'branch-a' }],
    });
    const inRecord = await service.clock(TENANT, cashier, {
      action: 'in',
      branchId: 'branch-a',
    });
    expect(inRecord).toMatchObject({
      employeeId: e.id,
      source: 'pos',
      clockOut: null,
      branchId: 'branch-a',
    });
    await expect(
      service.clock(TENANT, cashier, { action: 'in' }),
    ).rejects.toBeInstanceOf(ConflictException);

    const status = await service.myAttendance(TENANT, cashier);
    expect(status.open?.id).toBe(inRecord.id);

    const out = await service.clock(TENANT, cashier, { action: 'out' });
    expect(out.clockOut).toBeInstanceOf(Date);
    expect(table(EmployeeAttendance)).toHaveLength(1);
    expect(actions()).toEqual(
      expect.arrayContaining(['attendance.clock_in', 'attendance.clock_out']),
    );
    await expect(
      service.clock(TENANT, cashier, { action: 'out' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('clocks in only at a branch the employee is assigned to and the user works in', async () => {
    const { service } = setup();
    await service.create(TENANT, {
      firstName: 'A',
      lastName: 'One',
      userId: 'user-2',
      branches: [{ branchId: 'branch-a' }, { branchId: 'branch-b' }],
    });
    // Not assigned there
    await expect(
      service.clock(TENANT, cashier, {
        action: 'in',
        branchId: 'branch-z',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Assigned, but outside the login's branches
    await expect(
      service.clock(TENANT, cashierAtA, { action: 'in', branchId: 'branch-b' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // No branch given: the first allowed one
    const record = await service.clock(TENANT, cashierAtA, { action: 'in' });
    expect(record.branchId).toBe('branch-a');
  });

  it('refuses a clock-in when the employee has no branch the user can work in', async () => {
    const { service } = setup();
    await service.create(TENANT, {
      firstName: 'A',
      lastName: 'One',
      userId: 'user-2',
      branches: [{ branchId: 'branch-b' }],
    });
    await expect(
      service.clock(TENANT, cashierAtA, { action: 'in' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('hides employees outside the user branches (404) from every action', async () => {
    const { service, table } = setup();
    const atB = await service.create(TENANT, {
      firstName: 'B',
      lastName: 'Only',
      branches: [{ branchId: 'branch-b' }],
    });
    const unassigned = await service.create(TENANT, {
      firstName: 'No',
      lastName: 'Branch',
    });
    const atA = await service.create(TENANT, {
      firstName: 'A',
      lastName: 'Shop',
      branches: [{ branchId: 'branch-a' }],
    });
    for (const id of [atB.id, unassigned.id]) {
      await expect(service.findOne(TENANT, id, SCOPE_A)).rejects.toThrow(
        new NotFoundException('Employee not found'),
      );
      await expect(
        service.update(TENANT, id, { jobTitle: 'x' }, SCOPE_A),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.assignBranches(TENANT, id, [{ branchId: 'branch-a' }], SCOPE_A),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.linkUser(TENANT, id, 'user-3', SCOPE_A),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.unlinkUser(TENANT, id, SCOPE_A),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.deactivate(TENANT, branchManager, id, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.reactivate(TENANT, id, SCOPE_A),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.recordAttendance(TENANT, branchManager, id, {
          clockIn: '2026-09-24T08:00:00Z',
          note: 'paper timesheet',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    }
    expect(table(EmployeeAttendance)).toHaveLength(0);
    // Every-branch users see them all; the branch's own employee is visible
    await expect(service.findOne(TENANT, unassigned.id)).resolves.toBeTruthy();
    const own = await service.findOne(TENANT, atA.id, SCOPE_A);
    expect(own.id).toBe(atA.id);
  });

  it('lists only the employees of the user branches', async () => {
    const { service, conditions } = setup();
    await service.list(TENANT, {}, SCOPE_A);
    const scoped = conditions(Employee).find(([sql]) =>
      sql.includes('employee_branches sb'),
    );
    expect(scoped?.[1]).toEqual({ branchScopeIds: ['branch-a'] });

    await service.list(TENANT, {});
    expect(
      conditions(Employee).filter(([sql]) =>
        sql.includes('employee_branches sb'),
      ),
    ).toHaveLength(1);
  });

  it('a branch-limited user assigns only their branches and keeps the others', async () => {
    const { service, table } = setup();
    // Creating: at least one of their branches, none of the others
    await expect(
      service.create(TENANT, { firstName: 'A', lastName: 'B' }, SCOPE_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create(
        TENANT,
        {
          firstName: 'A',
          lastName: 'B',
          branches: [{ branchId: 'branch-b' }],
        },
        SCOPE_A,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const e = await service.create(TENANT, {
      firstName: 'Marie',
      lastName: 'Joseph',
      branches: [
        { branchId: 'branch-b', isPrimary: true },
        { branchId: 'branch-a' },
      ],
    });
    await expect(
      service.assignBranches(TENANT, e.id, [{ branchId: 'branch-b' }], SCOPE_A),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.assignBranches(TENANT, e.id, [], SCOPE_A),
    ).rejects.toBeInstanceOf(BadRequestException);
    // The primary branch is someone else's
    await expect(
      service.update(
        TENANT,
        e.id,
        { branches: [{ branchId: 'branch-a', isPrimary: true }] },
        SCOPE_A,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const updated = await service.assignBranches(
      TENANT,
      e.id,
      [{ branchId: 'branch-a' }],
      SCOPE_A,
    );
    expect(updated.branches).toEqual([
      { branchId: 'branch-b', isPrimary: true },
      { branchId: 'branch-a', isPrimary: false },
    ]);
    expect(table(EmployeeBranch)).toHaveLength(2);
  });

  it('records and closes shifts only at the user branches', async () => {
    const { service, table } = setup();
    const e = await service.create(TENANT, {
      firstName: 'A',
      lastName: 'One',
      branches: [{ branchId: 'branch-a' }, { branchId: 'branch-b' }],
    });
    await expect(
      service.recordAttendance(TENANT, branchManager, e.id, {
        clockIn: '2026-09-24T08:00:00Z',
        clockOut: '2026-09-24T12:00:00Z',
        branchId: 'branch-b',
        note: 'paper timesheet',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    // No branch given: one of theirs, so the record stays in their reach
    const recorded = await service.recordAttendance(
      TENANT,
      branchManager,
      e.id,
      {
        clockIn: '2026-09-24T08:00:00Z',
        clockOut: '2026-09-24T12:00:00Z',
        note: 'paper timesheet',
      },
    );
    expect(recorded.branchId).toBe('branch-a');

    table(EmployeeAttendance).push({
      id: 'att-b',
      tenantId: TENANT,
      employeeId: e.id,
      branchId: 'branch-b',
      clockIn: new Date('2026-09-24T13:00:00Z'),
      clockOut: null,
    });
    await expect(
      service.closeAttendance(
        TENANT,
        'att-b',
        { clockOut: '2026-09-24T17:00:00Z' },
        SCOPE_A,
      ),
    ).rejects.toThrow(new NotFoundException('Attendance record not found'));
    const closed = await service.closeAttendance(TENANT, 'att-b', {
      clockOut: '2026-09-24T17:00:00Z',
    });
    expect(closed.clockOut).toBeInstanceOf(Date);
  });

  it('limits the attendance report to the user branches', async () => {
    const { service, conditions } = setup();
    const atB = await service.create(TENANT, {
      firstName: 'B',
      lastName: 'Only',
      branches: [{ branchId: 'branch-b' }],
    });
    const range = { from: '2026-09-01T00:00:00Z', to: '2026-09-30T00:00:00Z' };
    await expect(
      service.attendanceReport(
        TENANT,
        { ...range, branchId: 'branch-b' },
        SCOPE_A,
      ),
    ).rejects.toThrow(new NotFoundException('Branch not found'));
    await expect(
      service.attendanceReport(
        TENANT,
        { ...range, employeeId: atB.id },
        SCOPE_A,
      ),
    ).rejects.toThrow(new NotFoundException('Employee not found'));

    await service.attendanceReport(TENANT, range, SCOPE_A);
    expect(conditions(EmployeeAttendance)).toContainEqual([
      '"a"."branchId" = ANY(:branchScopeIds)',
      { branchScopeIds: ['branch-a'] },
    ]);
  });

  it('rejects an admin record whose clock-out is before the clock-in', async () => {
    const { service } = setup();
    const e = await service.create(TENANT, { firstName: 'A', lastName: 'One' });
    await expect(
      service.recordAttendance(TENANT, admin, e.id, {
        clockIn: '2026-09-24T17:00:00Z',
        clockOut: '2026-09-24T08:00:00Z',
        note: 'paper timesheet',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('attendance hours', () => {
  const window = {
    from: new Date('2026-09-24T00:00:00Z'),
    to: new Date('2026-09-25T00:00:00Z'),
  };

  it('counts closed records, clips them to the range and runs open ones to now', () => {
    expect(
      spanHours(
        {
          clockIn: '2026-09-24T08:00:00Z',
          clockOut: '2026-09-24T16:30:00Z',
        },
        window,
      ),
    ).toBe(8.5);
    // Night shift started the day before: only the part inside the range
    expect(
      spanHours(
        {
          clockIn: '2026-09-23T22:00:00Z',
          clockOut: '2026-09-24T02:00:00Z',
        },
        window,
      ),
    ).toBe(2);
    expect(
      spanHours(
        { clockIn: '2026-09-24T20:00:00Z', clockOut: null },
        window,
        new Date('2026-09-24T21:15:00Z'),
      ),
    ).toBe(1.25);
    expect(
      totalHours(
        [
          {
            clockIn: '2026-09-24T08:00:00Z',
            clockOut: '2026-09-24T12:00:00Z',
          },
          {
            clockIn: '2026-09-24T13:00:00Z',
            clockOut: '2026-09-24T17:20:00Z',
          },
        ],
        window,
      ),
    ).toBe(8.33);
  });
});
