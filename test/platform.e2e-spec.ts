// Must come first: sign-up enabled for this app instance, NUMERIC columns as numbers
import './platform-env';
import '../src/database/pg-types';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { deleteTenant } from './helpers/delete-tenant';

/**
 * Platform end-to-end test: store sign-up (provisioning in one transaction),
 * sessions and sign-out, and devices, against the real database in .env.
 * Every store it creates is deleted in afterAll, even when tests fail.
 */

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER_EMAIL = `platform-e2e-${RUN}@test.local`;
const PASSWORD = 'TestPass123!';

jest.setTimeout(60_000);

describe('Platform (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  const tenantIds = new Set<string>();

  const api = (
    method: 'get' | 'post' | 'patch' | 'delete',
    path: string,
    body?: object,
    bearer?: string,
  ) => {
    // API-client mode: tokens in the body, bearer auth (see auth/session-cookie.ts)
    let req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('X-Auth-Mode', 'token');
    if (bearer) req = req.set('Authorization', `Bearer ${bearer}`);
    return body ? req.send(body) : req;
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ logger: ['error'] });
    // Exactly the server's request pipeline (src/app.setup.ts)
    configureApp(app);
    await app.init();
    dataSource = app.get(DataSource);
  });

  afterAll(async () => {
    try {
      if (dataSource?.isInitialized) {
        const users = await dataSource.query<{ id: string }[]>(
          `SELECT id FROM users WHERE email = $1`,
          [OWNER_EMAIL],
        );
        for (const tenantId of tenantIds) {
          await deleteTenant(dataSource, tenantId);
        }
        await dataSource.query(
          `DELETE FROM users WHERE id = ANY($1)
             AND NOT EXISTS (SELECT 1 FROM tenant_memberships m WHERE m."userId" = users.id)`,
          [users.map((u) => u.id)],
        );
      }
    } finally {
      delete process.env.ALLOW_SIGNUP;
      await app?.close();
    }
  });

  let token: string;
  let tenantId: string;

  it('reports that sign-up is enabled', async () => {
    const r = await api('get', '/tenants/signup-enabled');
    expect(r.body).toEqual({ enabled: true });
  });

  it('creates a store with owner, roles, defaults and a settings version', async () => {
    const r = await api('post', '/tenants/signup', {
      storeName: `Platform E2E ${RUN}`,
      email: OWNER_EMAIL,
      password: PASSWORD,
      firstName: 'Pat',
      currencyCode: 'eur',
    });
    expect(r.status).toBe(201);
    const body = r.body as { tenant: { id: string }; accessToken: string };
    tenantId = body.tenant.id;
    tenantIds.add(tenantId);
    token = body.accessToken;
    expect(r.body.user).toMatchObject({ role: 'owner', tenantId });

    const [roles, registers, methods, versions] = await Promise.all([
      dataSource.query(`SELECT key FROM tenant_roles WHERE "tenantId" = $1`, [
        tenantId,
      ]),
      dataSource.query(`SELECT id FROM registers WHERE "tenantId" = $1`, [
        tenantId,
      ]),
      dataSource.query(
        `SELECT code FROM payment_methods WHERE "tenantId" = $1`,
        [tenantId],
      ),
      dataSource.query(
        `SELECT version FROM settings_versions WHERE "tenantId" = $1`,
        [tenantId],
      ),
    ]);
    expect((roles as { key: string }[]).map((r) => r.key).sort()).toEqual([
      'admin',
      'cashier',
      'manager',
      'owner',
    ]);
    expect(registers).toHaveLength(1);
    expect(methods).toHaveLength(2);
    expect(versions).toHaveLength(1);

    const settings = await api('get', '/settings', undefined, token);
    expect(settings.body.currencyCode).toBe('EUR');
  });

  it('adds a second store to an existing account only with its password', async () => {
    const wrong = await api('post', '/tenants/signup', {
      storeName: `Platform E2E 2 ${RUN}`,
      email: OWNER_EMAIL,
      password: 'not-the-password',
    });
    expect(wrong.status).toBe(401);

    const r = await api('post', '/tenants/signup', {
      storeName: `Platform E2E 2 ${RUN}`,
      email: OWNER_EMAIL,
      password: PASSWORD,
    });
    expect(r.status).toBe(201);
    const body = r.body as { tenant: { id: string }; accessToken: string };
    tenantIds.add(body.tenant.id);

    const stores = await api(
      'get',
      '/auth/stores',
      undefined,
      body.accessToken,
    );
    expect(stores.body).toHaveLength(2);
  });

  it('logout ends the session', async () => {
    const login = await api('post', '/auth/login', {
      email: OWNER_EMAIL,
      password: PASSWORD,
    });
    const t = login.body.accessToken as string;
    expect((await api('get', '/sessions', undefined, t)).status).toBe(200);
    expect((await api('post', '/auth/logout', undefined, t)).status).toBe(200);
    expect((await api('get', '/sessions', undefined, t)).status).toBe(401);
  });

  it('registers a device and issues an offline lease', async () => {
    const device = await api('post', '/devices/register', {}, token);
    expect(device.status).toBe(201);
    const lease = await api(
      'post',
      `/devices/${device.body.id}/lease`,
      undefined,
      token,
    );
    expect(lease.body.leaseValid).toBe(true);
    const summary = await api('get', '/devices/summary', undefined, token);
    expect(summary.body.devices.active).toBe(1);
  });
});
