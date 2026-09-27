// Must come first: NUMERIC columns are parsed as numbers (same as main.ts)
import '../src/database/pg-types';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { deleteTenant } from './helpers/delete-tenant';

/**
 * Branch-level access (spec §3/§9, AC15) against the real database in .env.
 *
 * A throwaway store with two branches, each with its own warehouse, stock
 * location and register, and a sale at each. A member limited to branch A
 * (manager role: the permissions are not what stops them) must not read
 * branch B's sales by id, list, report or export, must not sell on branch B's
 * register, must not see branch B's stock, and its tills can't sync for them.
 * Everything of the store is deleted in afterAll, as in app.e2e-spec.ts.
 */

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER_EMAIL = `e2e-branch-owner-${RUN}@test.local`;
const STAFF_EMAIL = `e2e-branch-a-${RUN}@test.local`;
const PASSWORD = 'TestPass123!';

jest.setTimeout(60_000);

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

describe('Branch-level access (e2e, AC15)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let tenantId: string | undefined;
  const createdUserIds = new Set<string>();

  let ownerToken: string;
  let staffToken: string;
  let staffId: string;
  let cash: string;
  let variantId: string;
  const branchA = { id: '', registerId: '', locationId: '' };
  const branchB = { id: '', registerId: '', locationId: '', warehouseId: '' };
  let saleA: { id: string; saleNumber: string };
  let saleB: { id: string; saleNumber: string };
  let deviceB: string;

  const api = (
    method: Method,
    path: string,
    body?: object,
    bearer: string | null = ownerToken,
  ) => {
    // API-client mode: tokens in the body, bearer auth (see auth/session-cookie.ts)
    let req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('X-Auth-Mode', 'token');
    if (bearer) req = req.set('Authorization', `Bearer ${bearer}`);
    return body ? req.send(body) : req;
  };
  const asStaff = (method: Method, path: string, body?: object) =>
    api(method, path, body, staffToken);

  const today = new Date();
  const from = new Date(today.getTime() - 86_400_000).toISOString();
  const to = new Date(today.getTime() + 86_400_000).toISOString();

  const sellAt = (registerId: string, bearer: string, key: string) =>
    api(
      'post',
      '/sales',
      {
        registerId,
        items: [{ variantId, quantity: 1 }],
        payments: [{ paymentMethodId: cash, amount: 100 }],
        idempotencyKey: `${key}-${RUN}`,
      },
      bearer,
    );

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ logger: ['error'] });
    // Exactly the server's request pipeline (src/app.setup.ts)
    configureApp(app);
    await app.init();

    dataSource = app.get(DataSource);
    const [tenant] = await dataSource.query<{ id: string }[]>(
      `INSERT INTO tenants (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
      [`E2E Branch Store ${RUN}`, `e2e-branch-store-${RUN}`],
    );
    tenantId = tenant.id;
    const [owner] = await dataSource.query<{ id: string }[]>(
      `INSERT INTO users (email, "passwordHash", "firstName", "lastName")
       VALUES ($1, $2, 'E2E', 'Owner') RETURNING id`,
      [OWNER_EMAIL, await bcrypt.hash(PASSWORD, 4)],
    );
    createdUserIds.add(owner.id);
    await dataSource.query(
      `INSERT INTO tenant_memberships ("tenantId", "userId", status, role)
       VALUES ($1, $2, 'active', 'owner')`,
      [tenantId, owner.id],
    );
  });

  afterAll(async () => {
    try {
      if (dataSource?.isInitialized && tenantId) {
        await deleteTenant(dataSource, tenantId, createdUserIds);
      }
    } finally {
      await app?.close();
    }
  });

  describe('setup: two branches with their own stock and till', () => {
    it('signs the owner in and sets up branch A', async () => {
      const login = await api(
        'post',
        '/auth/login',
        { email: OWNER_EMAIL, password: PASSWORD },
        null,
      );
      expect(login.status).toBe(200);
      ownerToken = login.body.accessToken;
      // Owners always have every branch
      expect(login.body.user.branchIds).toBeNull();

      const init = await api('post', '/settings/initialize');
      expect(init.status).toBeLessThan(300);
      branchA.registerId = init.body.register.id;
      branchA.locationId = init.body.location.id;
      branchA.id = init.body.register.branchId;
      expect(branchA.id).toBeDefined();

      const context = await api('get', '/pos/context');
      cash = (
        context.body.paymentMethods as { id: string; code: string }[]
      ).find((m) => m.code === 'CASH')!.id;
    });

    it('adds branch B with its warehouse, location and register', async () => {
      let r = await api('post', '/branches', {
        code: 'B',
        name: 'Branch B',
        currencyCode: 'USD',
      });
      expect(r.status).toBe(201);
      branchB.id = r.body.id;

      r = await api('post', '/warehouses', { code: 'WB', name: 'Warehouse B' });
      expect(r.status).toBe(201);
      branchB.warehouseId = r.body.id;

      r = await api('post', '/locations', {
        warehouseId: branchB.warehouseId,
        code: 'LB',
        name: 'Shelf B',
      });
      expect(r.status).toBe(201);
      branchB.locationId = r.body.id;

      r = await api('post', '/registers', {
        branchId: branchB.id,
        code: 'RB',
        name: 'Till B',
        defaultLocationId: branchB.locationId,
      });
      expect(r.status).toBe(201);
      branchB.registerId = r.body.id;

      // The till's warehouse now serves its branch
      r = await api('get', '/branch-warehouses');
      expect(r.body).toContainEqual({
        branchId: branchB.id,
        warehouseId: branchB.warehouseId,
      });
    });

    it('stocks a product at both branches and sells once at each', async () => {
      const product = await api('post', '/products', {
        sku: `BR-${RUN}`.slice(0, 50),
        name: { en: 'Branch item' },
        price: 10,
      });
      expect(product.status).toBe(201);
      variantId = product.body.variants[0].id;

      for (const locationId of [branchA.locationId, branchB.locationId]) {
        const r = await api('post', '/inventory/receive', {
          locationId,
          reference: 'E2E',
          items: [{ variantId, quantity: 10, cost: 2 }],
        });
        expect(r.status).toBeLessThan(300);
      }

      const a = await sellAt(branchA.registerId, ownerToken, 'sale-a');
      expect(a.status).toBe(201);
      saleA = a.body;
      const b = await sellAt(branchB.registerId, ownerToken, 'sale-b');
      expect(b.status).toBe(201);
      saleB = b.body;
    });

    it('owner enrolls a till on branch B', async () => {
      const r = await api('post', '/devices/register', {
        name: 'Till B device',
        registerId: branchB.registerId,
      });
      expect(r.status).toBe(201);
      deviceB = r.body.id;
    });

    it('adds a manager limited to branch A', async () => {
      const r = await api('post', '/users', {
        email: STAFF_EMAIL,
        password: PASSWORD,
        firstName: 'Branch',
        lastName: 'A',
        role: 'manager',
        branchIds: [branchA.id],
      });
      expect(r.status).toBe(201);
      expect(r.body.branchIds).toEqual([branchA.id]);
      staffId = r.body.id;
      createdUserIds.add(staffId);

      const login = await api(
        'post',
        '/auth/login',
        { email: STAFF_EMAIL, password: PASSWORD },
        null,
      );
      expect(login.status).toBe(200);
      expect(login.body.user.branchIds).toEqual([branchA.id]);
      staffToken = login.body.accessToken;
    });
  });

  describe('sales', () => {
    it("reads branch A's sale but not branch B's (guessed id: 404)", async () => {
      expect((await asStaff('get', `/sales/${saleA.id}`)).status).toBe(200);
      expect((await asStaff('get', `/sales/${saleB.id}`)).status).toBe(404);
      // Nor acts on it
      expect((await asStaff('post', `/sales/${saleB.id}/reprint`)).status).toBe(
        404,
      );
      expect(
        (
          await asStaff('post', `/sales/${saleB.id}/void`, {
            reason: 'Not mine',
          })
        ).status,
      ).toBe(404);
    });

    it("lists only branch A's sales", async () => {
      const r = await asStaff('get', '/sales?limit=100');
      expect(r.status).toBe(200);
      const ids = (r.body.data as { id: string }[]).map((s) => s.id);
      expect(ids).toContain(saleA.id);
      expect(ids).not.toContain(saleB.id);
    });

    it('does not find the branch-B sale for a return', async () => {
      const r = await asStaff(
        'get',
        `/returns/lookup?saleNumber=${encodeURIComponent(saleB.saleNumber)}`,
      );
      expect(r.status).toBe(404);
    });

    it("the till only offers branch A's registers", async () => {
      const r = await asStaff('get', '/pos/context');
      const ids = (r.body.registers as { id: string }[]).map((x) => x.id);
      expect(ids).toEqual([branchA.registerId]);
      const registers = await asStaff('get', '/registers');
      expect(
        (registers.body as { id: string }[]).map((x) => x.id),
      ).not.toContain(branchB.registerId);
      const branches = await asStaff('get', '/branches');
      expect((branches.body as { id: string }[]).map((x) => x.id)).toEqual([
        branchA.id,
      ]);
    });

    it("can't sell (or quote) on branch B's register", async () => {
      const sale = await sellAt(branchB.registerId, staffToken, 'staff-b');
      expect(sale.status).toBe(404);
      const quote = await asStaff('post', '/sales/quote', {
        registerId: branchB.registerId,
        items: [{ variantId, quantity: 1 }],
      });
      expect(quote.status).toBe(404);
      // …and sells at branch A as usual
      const own = await sellAt(branchA.registerId, staffToken, 'staff-a');
      expect(own.status).toBe(201);
    });
  });

  describe('reports and exports', () => {
    it('reports cover branch A only; asking for branch B is refused', async () => {
      const mine = await asStaff(
        'get',
        `/reports/sales-by-day?from=${from}&to=${to}`,
      );
      expect(mine.status).toBe(200);
      expect(mine.body.branchIds).toEqual([branchA.id]);
      const all = await api(
        'get',
        `/reports/sales-by-day?from=${from}&to=${to}`,
      );
      expect(all.body.branchIds).toBeNull();
      // Owner: 3 sales (A, B, staff at A); branch A user: the 2 at A
      expect(Number(all.body.totals.saleCount)).toBe(3);
      expect(Number(mine.body.totals.saleCount)).toBe(2);

      const other = await asStaff(
        'get',
        `/reports/sales-by-day?from=${from}&to=${to}&branchId=${branchB.id}`,
      );
      expect(other.status).toBe(403);

      const summary = await asStaff(
        'get',
        `/reports/summary?from=${from}&to=${to}`,
      );
      expect(summary.body.branchIds).toEqual([branchA.id]);
    });

    it('no export of branch B, and no download of a store-wide file', async () => {
      const direct = await asStaff(
        'get',
        `/reports/sales-by-day/export?format=csv&from=${from}&to=${to}&branchId=${branchB.id}`,
      );
      expect(direct.status).toBe(403);
      const queued = await asStaff('post', '/exports', {
        reportKey: 'sales-by-day',
        format: 'csv',
        params: { from, to, branchId: branchB.id },
      });
      expect(queued.status).toBe(403);

      // A finished file covering every branch (e.g. made before the user was
      // limited to branch A) is no longer theirs to download
      const expiresAt = new Date(Date.now() + 3_600_000);
      const insert = (scope: object | null) =>
        dataSource.query<{ id: string }[]>(
          `INSERT INTO export_jobs ("tenantId", "userId", "reportKey", params, scope, format,
                                    status, "fileKey", "fileName", "finishedAt", "expiresAt")
           VALUES ($1, $2, 'sales-by-day', '{}', $3, 'csv', 'done', $4, 'x.csv', now(), $5)
           RETURNING id`,
          [
            tenantId,
            staffId,
            scope ? JSON.stringify(scope) : null,
            `private/exports/${tenantId}/${'a'.repeat(32)}.csv`,
            expiresAt,
          ],
        );
      const [storeWide] = await insert(null);
      expect((await asStaff('get', `/exports/${storeWide.id}`)).status).toBe(
        404,
      );
      const [own] = await insert({ branchIds: [branchA.id] });
      const ok = await asStaff('get', `/exports/${own.id}`);
      expect(ok.status).toBe(200);
      expect(ok.body.downloadUrl).toBeTruthy();
    });
  });

  describe('stock', () => {
    it("sees branch A's stock but not branch B's locations", async () => {
      const all = await asStaff('get', '/inventory/stock');
      expect(all.status).toBe(200);
      const locations = new Set(
        (all.body as { locationId: string }[]).map((r) => r.locationId),
      );
      expect(locations.has(branchA.locationId)).toBe(true);
      expect(locations.has(branchB.locationId)).toBe(false);

      const b = await asStaff(
        'get',
        `/inventory/stock?locationId=${branchB.locationId}`,
      );
      expect(b.body).toEqual([]);
      expect(
        (await asStaff('get', `/locations/${branchB.locationId}`)).status,
      ).toBe(404);
      const movements = await asStaff(
        'get',
        `/inventory/movements?locationId=${branchB.locationId}`,
      );
      expect(movements.body).toEqual([]);
    });

    it("can't adjust branch B's stock", async () => {
      const r = await asStaff('post', '/inventory/adjustments', {
        locationId: branchB.locationId,
        reason: 'recount',
        mode: 'set',
        items: [{ variantId, quantity: 0 }],
      });
      expect(r.status).toBe(404);
    });
  });

  describe('devices and sync', () => {
    it("branch B's till doesn't work for a branch-A user", async () => {
      const heartbeat = await asStaff('post', `/devices/${deviceB}/heartbeat`, {
        pendingSales: 0,
      });
      expect(heartbeat.status).toBe(404);
      const enroll = await asStaff('post', '/devices/register', {
        registerId: branchB.registerId,
      });
      expect(enroll.status).toBe(404);
      const push = await asStaff('post', '/sync/push', {
        deviceId: deviceB,
        operations: [
          {
            deviceOperationId: `op-${RUN}`,
            deviceSequence: 1,
            type: 'sale.create',
            schemaVersion: 1,
            payloadHash: '0'.repeat(64),
            payload: { registerId: branchB.registerId },
          },
        ],
      });
      expect(push.status).toBe(404);
      const changes = await asStaff(
        'get',
        `/sync/changes?registerId=${branchB.registerId}`,
      );
      expect(changes.status).toBe(404);
    });
  });

  describe('users', () => {
    it('owners see and can change the branches of a member', async () => {
      const list = await api('get', '/users');
      const staff = (list.body as { id: string; branchIds: string[] }[]).find(
        (m) => m.id === staffId,
      );
      expect(staff?.branchIds).toEqual([branchA.id]);
      const r = await api('patch', `/users/${staffId}`, {
        branchIds: [branchA.id, branchB.id],
      });
      expect(r.status).toBe(200);
      expect(r.body.branchIds).toEqual([branchA.id, branchB.id]);
      // Applies to the next request, no new login needed
      expect((await asStaff('get', `/sales/${saleB.id}`)).status).toBe(200);
    });
  });
});
