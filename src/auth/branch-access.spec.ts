/**
 * Branch-level access (spec §3/§9, AC15): a user limited to branch A can't read
 * or act on branch B's records — guessed ids answer 404, lists are filtered,
 * exports and sync refuse. One or more checks per area; the real-database
 * version is test/branch-access.e2e-spec.ts.
 */
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { requestContext } from '../common/context/request-context';
import type { AuthUser } from './strategies/jwt.strategy';
import { ALL_PERMISSIONS } from './permissions';
import { SalesService } from '../sales/sales.service';
import { PosService } from '../sales/pos.service';
import { ShiftsService } from '../shifts/shifts.service';
import { DrawersService } from '../shifts/drawers.service';
import { ExpensesService } from '../expenses/expenses.service';
import { ReturnsService } from '../returns/returns.service';
import { ExchangesService } from '../returns/exchanges.service';
import { EstimatesService } from '../estimates/estimates.service';
import { StockTransfersService } from '../inventory/stock-transfers.service';
import { StockCountsService } from '../inventory/stock-counts.service';
import { InventoryService } from '../inventory/inventory.service';
import { PurchaseOrdersService } from '../purchasing/purchase-orders.service';
import { ExportsService } from '../exports/exports.service';
import { SyncPushService } from '../sync/sync-push.service';
import { DevicesService } from '../devices/devices.service';
import { PrintJobsService } from '../documents/print-jobs.service';
import { UsersService } from '../users/users.service';
import {
  BranchesService,
  RegistersService,
} from '../settings/settings-resources.service';
import { branchFilter, scopeOf } from '../reports/report-sql';

const TENANT = 'tenant-1';
const A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const B = 'bbbbbbbb-0000-4000-8000-00000000000b';

const cashierA = {
  id: 'cashier-a',
  tenantId: TENANT,
  role: 'manager',
  permissions: ALL_PERMISSIONS,
  branchIds: [A],
} as unknown as AuthUser;

/** Run as the branch-A user (what JwtStrategy sets on each request) */
const asBranchA = <T>(fn: () => Promise<T> | T): Promise<T> =>
  Promise.resolve(
    requestContext.run(
      { userId: cashierA.id, tenantId: TENANT, branchIds: [A] },
      fn,
    ),
  );

/** Chainable query builder stub recording its conditions */
function fakeQb(result: { one?: unknown; many?: unknown[]; count?: number }) {
  const wheres: { sql: string; params?: Record<string, unknown> }[] = [];
  const qb: Record<string, unknown> = {};
  const self = () => qb;
  for (const m of [
    'leftJoin',
    'leftJoinAndSelect',
    'innerJoin',
    'innerJoinAndSelect',
    'addSelect',
    'select',
    'from',
    'where',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
    'limit',
    'setLock',
  ]) {
    qb[m] = jest.fn(self);
  }
  qb.andWhere = jest.fn((sql: string, params?: Record<string, unknown>) => {
    wheres.push({ sql, params });
    return qb;
  });
  qb.getOne = jest.fn().mockResolvedValue(result.one ?? null);
  qb.getMany = jest.fn().mockResolvedValue(result.many ?? []);
  qb.getRawMany = jest.fn().mockResolvedValue(result.many ?? []);
  qb.getCount = jest.fn().mockResolvedValue(result.count ?? 0);
  qb.getManyAndCount = jest
    .fn()
    .mockResolvedValue([result.many ?? [], result.count ?? 0]);
  return { qb, wheres };
}

const scoped = (wheres: { params?: Record<string, unknown> }[]) =>
  wheres.some((w) =>
    Object.values(w.params ?? {}).some(
      (v) => Array.isArray(v) && v.length === 1 && v[0] === A,
    ),
  );

/** Manager whose raw queries answer by SQL fragment */
function fakeManager(answers: [RegExp, unknown[]][] = []) {
  return {
    query: jest.fn((sql: string) => {
      const hit = answers.find(([re]) => re.test(sql));
      return Promise.resolve(hit ? hit[1] : []);
    }),
  };
}

const construct = <T>(Cls: new (...args: never[]) => T, args: unknown[]) =>
  new Cls(...(args as never[]));

describe('Branch-level access (AC15)', () => {
  describe('sales', () => {
    const saleB = { id: 'sale-b', tenantId: TENANT, branchId: B };

    it('a guessed id of a branch-B sale is not found', async () => {
      const { qb } = fakeQb({ one: saleB });
      const service = construct(SalesService, [
        { createQueryBuilder: () => qb },
      ]);
      await expect(
        asBranchA(() => service.findOne(TENANT, 'sale-b')),
      ).rejects.toThrow(NotFoundException);
      // An every-branch user reads it
      await expect(service.findOne(TENANT, 'sale-b')).resolves.toBe(saleB);
    });

    it('the history only lists the branches of the user', async () => {
      const { qb, wheres } = fakeQb({ many: [] });
      const service = construct(SalesService, [
        { createQueryBuilder: () => qb },
      ]);
      await asBranchA(() => service.findAll(TENANT, {}));
      expect(scoped(wheres)).toBe(true);
    });

    it('reprinting a branch-B receipt is not found', async () => {
      const service = construct(SalesService, [
        {
          findOne: jest
            .fn()
            .mockResolvedValue({ ...saleB, status: 'completed' }),
        },
      ]);
      await expect(
        asBranchA(() => service.reprint(TENANT, 'sale-b')),
      ).rejects.toThrow(NotFoundException);
    });

    it('no sale (or quote) on a register of branch B', async () => {
      const registerB = {
        id: 'reg-b',
        branchId: B,
        status: 'active',
        defaultLocationId: 'loc-b',
      };
      const dataSource = {
        getRepository: () => ({
          findOne: jest.fn().mockResolvedValue(registerB),
        }),
      };
      const service = construct(SalesService, [{}, {}, {}, {}, {}, dataSource]);
      await expect(
        asBranchA(() =>
          service.quote(TENANT, cashierA, {
            registerId: 'reg-b',
            items: [{ variantId: 'v', quantity: 1 }],
          }),
        ),
      ).rejects.toThrow(new NotFoundException('Register not found'));
    });

    it("the POS catalog won't show stock of a branch-B till", async () => {
      const dataSource = {
        getRepository: () => ({
          findOne: jest.fn().mockResolvedValue({ id: 'reg-b', branchId: B }),
        }),
      };
      const service = construct(PosService, [dataSource]);
      await expect(
        asBranchA(() => service.getCatalog(TENANT, { registerId: 'reg-b' })),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('shifts, drawers and expenses', () => {
    it('a branch-B shift (and its Z-report) is not found', async () => {
      const shiftB = {
        id: 'shift-b',
        tenantId: TENANT,
        registerId: 'reg-b',
        branchId: B,
      };
      const service = construct(ShiftsService, [
        { findOne: jest.fn().mockResolvedValue(shiftB) },
        {},
        {},
        { manager: fakeManager() },
      ]);
      await expect(
        asBranchA(() => service.findOne(TENANT, cashierA, 'shift-b')),
      ).rejects.toThrow(NotFoundException);
      await expect(
        asBranchA(() => service.zReport(TENANT, cashierA, 'shift-b')),
      ).rejects.toThrow(NotFoundException);
    });

    it("an older shift without a branch takes its register's", async () => {
      const shift = { id: 's', tenantId: TENANT, registerId: 'reg-b' };
      const manager = fakeManager([[/FROM registers/, [{ branchId: B }]]]);
      const service = construct(ShiftsService, [
        { findOne: jest.fn().mockResolvedValue(shift) },
        {},
        {},
        { manager },
      ]);
      await expect(
        asBranchA(() => service.findOne(TENANT, cashierA, 's')),
      ).rejects.toThrow(NotFoundException);
    });

    it('the shift list is limited to the branches of the user', async () => {
      const { qb, wheres } = fakeQb({ many: [] });
      const service = construct(ShiftsService, [
        { createQueryBuilder: () => qb },
        {},
        {},
        { manager: fakeManager() },
        {},
        {},
        { getSettings: jest.fn().mockResolvedValue({}) },
      ]);
      await asBranchA(() => service.list(TENANT, cashierA, {}));
      expect(scoped(wheres)).toBe(true);
    });

    it('no shift opened on a branch-B register', async () => {
      const dataSource = {
        getRepository: () => ({
          findOne: jest
            .fn()
            .mockResolvedValue({ id: 'reg-b', branchId: B, status: 'active' }),
        }),
      };
      const service = construct(ShiftsService, [{}, {}, {}, dataSource]);
      await expect(
        asBranchA(() =>
          service.open(TENANT, cashierA, { registerId: 'reg-b' }),
        ),
      ).rejects.toThrow(new NotFoundException('Register not found'));
    });

    it('no drawer added to a branch-B register', async () => {
      const dataSource = {
        getRepository: () => ({
          findOne: jest.fn().mockResolvedValue({ id: 'reg-b', branchId: B }),
        }),
      };
      const service = construct(DrawersService, [dataSource, {}]);
      await expect(
        asBranchA(() =>
          service.create(TENANT, {
            registerId: 'reg-b',
            code: 'D2',
            name: 'Drawer 2',
          }),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('an expense paid at a branch-B till is not found', async () => {
      const expense = {
        id: 'exp-b',
        tenantId: TENANT,
        registerId: 'reg-b',
        createdById: 'someone',
      };
      const service = construct(ExpensesService, [
        { findOne: jest.fn().mockResolvedValue(expense) },
        { manager: fakeManager([[/FROM registers/, [{ branchId: B }]]]) },
      ]);
      await expect(
        asBranchA(() => service.findOne(TENANT, cashierA, 'exp-b')),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('returns, exchanges and estimates', () => {
    it('a return of a branch-B sale is not found, and its sale not found at lookup', async () => {
      const ret = fakeQb({
        one: { id: 'ret-b', originalSale: { id: 'sale-b', branchId: B } },
      });
      const lookup = fakeQb({
        one: { id: 'sale-b', branchId: B, items: [] },
      });
      const service = construct(ReturnsService, [
        { createQueryBuilder: () => ret.qb },
        { getRepository: () => ({ createQueryBuilder: () => lookup.qb }) },
      ]);
      await expect(
        asBranchA(() => service.findOne(TENANT, 'ret-b')),
      ).rejects.toThrow(NotFoundException);
      await expect(
        asBranchA(() => service.lookupSale(TENANT, 'S-B-0001')),
      ).rejects.toThrow(NotFoundException);
    });

    it('the returns list is limited to the branches of the user', async () => {
      const { qb, wheres } = fakeQb({ many: [] });
      const service = construct(ReturnsService, [
        { createQueryBuilder: () => qb },
      ]);
      await asBranchA(() => service.findAll(TENANT, {}));
      expect(scoped(wheres)).toBe(true);
    });

    it('an exchange of a branch-B sale is not found', async () => {
      const link = { id: 'x-b', tenantId: TENANT, originalSaleId: 'sale-b' };
      const dataSource = {
        getRepository: jest.fn((entity: { name: string }) => ({
          findOne: jest
            .fn()
            .mockResolvedValue(
              entity.name === 'ExchangeLink'
                ? link
                : { id: 'sale-b', branchId: B },
            ),
        })),
      };
      const service = construct(ExchangesService, [dataSource]);
      await expect(
        asBranchA(() => service.findOne(TENANT, 'x-b')),
      ).rejects.toThrow(NotFoundException);
    });

    it('a branch-B estimate is not found; a store-level one is visible', async () => {
      const findOne = jest.fn();
      const service = construct(EstimatesService, [{ findOne }]);
      findOne.mockResolvedValueOnce({ id: 'e-b', branchId: B, items: [] });
      await expect(
        asBranchA(() => service.findOne(TENANT, 'e-b')),
      ).rejects.toThrow(NotFoundException);
      findOne.mockResolvedValueOnce({
        id: 'e-0',
        branchId: null,
        items: [],
        subtotal: 0,
        taxAmount: 0,
        discountAmount: 0,
        total: 0,
      });
      await expect(
        asBranchA(() => service.findOne(TENANT, 'e-0')),
      ).resolves.toBeDefined();
    });
  });

  describe('stock', () => {
    // Locations of branch A: loc-a (the fake answers "accessible" for it only)
    const locationManager = () => ({
      query: jest.fn((sql: string, params: unknown[]) =>
        Promise.resolve(
          /x\.id = \$3/.test(sql)
            ? params[2] === 'loc-a'
              ? [{ ok: 1 }]
              : []
            : [{ id: 'loc-a' }],
        ),
      ),
    });

    it('a transfer between branch-B locations is not found', async () => {
      const { qb } = fakeQb({
        one: {
          id: 't-b',
          tenantId: TENANT,
          fromLocationId: 'loc-b',
          toLocationId: 'loc-b2',
          items: [],
        },
      });
      const service = construct(StockTransfersService, [
        {
          getRepository: () => ({ createQueryBuilder: () => qb }),
          manager: locationManager(),
        },
      ]);
      await expect(asBranchA(() => service.get(TENANT, 't-b'))).rejects.toThrow(
        NotFoundException,
      );
    });

    it('dispatch needs the source branch, receipt the destination', async () => {
      const service = construct(StockTransfersService, [
        { manager: locationManager() },
      ]);
      const check = (
        transfer: { fromLocationId: string; toLocationId: string },
        action: string,
      ) =>
        asBranchA(() =>
          (
            service as unknown as {
              assertTransferAccess: (
                m: unknown,
                t: unknown,
                a: string,
              ) => Promise<void>;
            }
          ).assertTransferAccess(
            locationManager(),
            { tenantId: TENANT, ...transfer },
            action,
          ),
        );
      const inbound = { fromLocationId: 'loc-b', toLocationId: 'loc-a' };
      const outbound = { fromLocationId: 'loc-a', toLocationId: 'loc-b' };
      await expect(check(inbound, 'view')).resolves.toBeUndefined();
      await expect(check(inbound, 'receive')).resolves.toBeUndefined();
      await expect(check(inbound, 'dispatch')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(check(outbound, 'dispatch')).resolves.toBeUndefined();
      await expect(check(outbound, 'receive')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('a stock count at a branch-B location is not found', async () => {
      const service = construct(StockCountsService, [
        {
          getRepository: () => ({
            findOne: jest.fn().mockResolvedValue({
              id: 'c-b',
              locationId: 'loc-b',
            }),
          }),
          manager: locationManager(),
        },
      ]);
      await expect(asBranchA(() => service.get(TENANT, 'c-b'))).rejects.toThrow(
        NotFoundException,
      );
    });

    it('stock views are limited to the locations of the branches', async () => {
      const { qb, wheres } = fakeQb({ many: [] });
      const service = construct(InventoryService, [
        {},
        {},
        {},
        { createQueryBuilder: () => qb },
      ]);
      await asBranchA(() => service.listStock(TENANT, {}));
      const location = wheres.find((w) => w.sql.includes('branch_warehouses'));
      expect(location?.params).toEqual({ branchScopeIds: [A] });
    });

    it('no adjustment at a branch-B location', async () => {
      const service = construct(InventoryService, [
        {},
        {},
        {},
        {
          getRepository: () => ({ exists: jest.fn().mockResolvedValue(true) }),
          manager: locationManager(),
        },
      ]);
      await expect(
        asBranchA(() =>
          service.createAdjustment(TENANT, cashierA.id, {
            locationId: 'loc-b',
            items: [],
          } as never),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('a purchase order received at a branch-B location is not found', async () => {
      const { qb } = fakeQb({
        one: { id: 'po-b', locationId: 'loc-b', items: [] },
      });
      const manager = {
        ...locationManager(),
        getRepository: () => ({ createQueryBuilder: () => qb }),
      };
      const service = construct(PurchaseOrdersService, [{ manager }]);
      await expect(
        asBranchA(() => service.get(TENANT, 'po-b')),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('reports and exports', () => {
    it("the user's branches become the report scope", () => {
      expect(scopeOf(cashierA)).toEqual({ branchIds: [A] });
      expect(scopeOf({ branchIds: null })).toBeUndefined();
      expect(branchFilter(null, scopeOf(cashierA))).toEqual([A]);
      expect(() => branchFilter(B, scopeOf(cashierA))).toThrow(
        ForbiddenException,
      );
    });

    it('an export is downloadable only within the branches the user has now', () => {
      const may = (jobScope: string[] | null, userScope?: string[]) => () =>
        ExportsService.prototype.assertMayDownload.call(
          {},
          {
            reportKey: 'sales-by-day',
            scope: jobScope ? { branchIds: jobScope } : null,
          },
          ['reports.view', 'reports.export', 'sales.view'],
          userScope ? { branchIds: userScope } : undefined,
        );
      expect(may([A], [A])).not.toThrow();
      // A store-wide file, or one of another branch: not for a branch-A user
      expect(may(null, [A])).toThrow(NotFoundException);
      expect(may([A, B], [A])).toThrow(NotFoundException);
      expect(may([B])).not.toThrow();
    });
  });

  describe('devices and sync', () => {
    it('a till enrolled at branch B does not sync for a branch-A user', async () => {
      const manager = fakeManager([
        [/FROM devices/, [{ registerId: 'reg-b' }]],
        [/FROM registers/, [{ branchId: B }]],
      ]);
      const salesService = { create: jest.fn() };
      const service = construct(SyncPushService, [{ manager }, salesService]);
      await expect(
        asBranchA(() =>
          service.push(TENANT, cashierA, {
            deviceId: 'dev-b',
            operations: [],
          }),
        ),
      ).rejects.toThrow(new NotFoundException('Device not found'));
      expect(salesService.create).not.toHaveBeenCalled();
    });

    it('offline sales of a branch-B register are refused as a whole', async () => {
      const manager = fakeManager([[/FROM registers/, [{ branchId: B }]]]);
      const service = construct(SyncPushService, [{ manager }, {}]);
      await expect(
        asBranchA(() =>
          service.push(TENANT, cashierA, {
            operations: [{ payload: { registerId: 'reg-b' } }],
          } as never),
        ),
      ).rejects.toThrow(new NotFoundException('Register not found'));
    });

    it("a branch-B till's heartbeat / lease is not found", async () => {
      const service = construct(DevicesService, [
        {
          findOne: jest
            .fn()
            .mockResolvedValue({ id: 'dev-b', registerId: 'reg-b' }),
        },
        { manager: fakeManager([[/FROM registers/, [{ branchId: B }]]]) },
      ]);
      await expect(
        asBranchA(() =>
          service.heartbeat(TENANT, cashierA, 'dev-b', {
            pendingSales: 0,
          }),
        ),
      ).rejects.toThrow(new NotFoundException('Device not found'));
      await expect(
        asBranchA(() => service.renewLease(TENANT, cashierA, 'dev-b')),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('documents', () => {
    it('the print history of a branch-B receipt is not found', async () => {
      const manager = fakeManager([[/FROM "sales"/, [{ branchId: B }]]]);
      const service = construct(PrintJobsService, [
        { manager, query: jest.fn() },
      ]);
      await expect(
        asBranchA(() => service.list(TENANT, 'receipt', 'sale-b')),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('settings: branches and registers', () => {
    it('lists only the branches and tills of the user', async () => {
      const find = jest
        .fn<Promise<unknown[]>, [{ where: unknown }]>()
        .mockResolvedValue([]);
      const branches = construct(BranchesService, [{ find }]);
      await asBranchA(() => branches.findAll(TENANT));
      expect(JSON.stringify(find.mock.calls[0][0].where)).toContain(A);

      const registers = construct(RegistersService, [
        {
          find,
          findOne: jest.fn().mockResolvedValue({ id: 'r', branchId: B }),
        },
      ]);
      await asBranchA(() => registers.findAll(TENANT));
      expect(JSON.stringify(find.mock.calls[1][0].where)).toContain(A);
      await expect(
        asBranchA(() => registers.findOne(TENANT, 'r')),
      ).rejects.toThrow(NotFoundException);
    });

    it('a branch-limited admin cannot add a branch', async () => {
      const branches = construct(BranchesService, [{}]);
      await expect(
        asBranchA(() => branches.create(TENANT, { code: 'X', name: 'X' })),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('users: assigning branches (no escalation)', () => {
    const roles = {
      findByKey: jest.fn().mockResolvedValue({
        key: 'cashier',
        name: 'Cashier',
        permissions: [],
      }),
      findAll: jest.fn().mockResolvedValue([]),
    };
    const service = () =>
      construct(UsersService, [
        {
          findOne: jest.fn().mockResolvedValue({
            userId: 'u2',
            role: 'cashier',
            branchIds: null,
            user: { id: 'u2' },
          }),
        },
        {},
        {},
        { getRepository: () => ({ count: jest.fn().mockResolvedValue(1) }) },
        roles,
        { record: jest.fn() },
      ]);

    it('a branch-limited admin cannot give access to every branch', async () => {
      await expect(
        service().create(TENANT, cashierA, {
          email: 'x@example.com',
          role: 'cashier',
          branchIds: null,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('nor to a branch they do not have', async () => {
      await expect(
        service().create(TENANT, cashierA, {
          email: 'x@example.com',
          role: 'cashier',
          branchIds: [B],
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('nor change a member who has every branch', async () => {
      await expect(
        service().update(TENANT, cashierA, 'u2', { firstName: 'X' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('owners always have every branch', async () => {
      const owner = { ...cashierA, role: 'owner', branchIds: null };
      roles.findByKey.mockResolvedValueOnce({ key: 'owner', permissions: [] });
      await expect(
        service().create(TENANT, owner as AuthUser, {
          email: 'x@example.com',
          role: 'owner',
          branchIds: [A],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
