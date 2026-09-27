/**
 * Throwaway-store helpers shared by the Node load test (checkout-load.mjs) and the
 * restore drill (scripts/restore-drill.mjs).
 *
 * - createTenant(): inserts a store, an owner user and the membership directly in the
 *   database (same as test/branch-access.e2e-spec.ts), so no sign-up throttle applies.
 * - setupStore(): signs in, initializes the store (register, location, payment methods),
 *   creates products and receives stock through the API.
 * - deleteTenant(): JS port of test/helpers/delete-tenant.ts (append-only ledgers are
 *   purged under the session-level `app.audit_purge` flag on one dedicated client).
 *
 * Never point these at a store you care about: deleteTenant removes everything in it.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
export const backendDir = path.resolve(here, '..', '..');
const require = createRequire(path.join(backendDir, 'package.json'));

export const { Client } = require('pg');
const bcrypt = require('bcrypt');

/** Load DB_* (and the rest) from top-backend/.env without overriding real env vars */
export function loadEnv() {
  require('dotenv').config({
    path: path.join(backendDir, '.env'),
    quiet: true,
  });
}

export function dbConfig() {
  return {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USERNAME,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_DATABASE,
    ssl:
      process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    application_name: 'pos-load-fixture',
  };
}

export async function connect() {
  const client = new Client(dbConfig());
  await client.connect();
  return client;
}

/** Round-trip time of a trivial query (ms), measured `n` times on an open client */
export async function measureDbRtt(client, n = 10) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const start = process.hrtime.bigint();
    await client.query('SELECT 1');
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return samples;
}

export const PASSWORD = 'LoadTest123!';

export async function createTenant(client, prefix = 'loadtest') {
  const run = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const slug = `${prefix}-${run}`;
  if (slug === 'default-tenant')
    throw new Error('refusing to use default-tenant');
  const email = `${prefix}-owner-${run}@test.local`;
  const {
    rows: [tenant],
  } = await client.query(
    `INSERT INTO tenants (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`Load Test Store ${run}`, slug],
  );
  const {
    rows: [user],
  } = await client.query(
    `INSERT INTO users (email, "passwordHash", "firstName", "lastName")
     VALUES ($1, $2, 'Load', 'Owner') RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 4)],
  );
  await client.query(
    `INSERT INTO tenant_memberships ("tenantId", "userId", status, role)
     VALUES ($1, $2, 'active', 'owner')`,
    [tenant.id, user.id],
  );
  return { tenantId: tenant.id, slug, email, userIds: new Set([user.id]) };
}

/** Small JSON API client with timing */
export function apiClient(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');
  let token = null;
  const call = async (method, p, body) => {
    const start = performance.now();
    let status = 0;
    let json;
    try {
      const res = await fetch(`${base}${p}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          // API-client mode: token in the login body, bearer auth, CSRF check satisfied
          'X-Auth-Mode': 'token',
          ...(token && { Authorization: `Bearer ${token}` }),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      status = res.status;
      const text = await res.text();
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = text;
      }
    } catch (err) {
      json = { error: String(err?.cause?.code || err?.message || err) };
    }
    return { status, body: json, ms: performance.now() - start };
  };
  return {
    call,
    setToken: (t) => (token = t),
    // Setup calls: retry while the API is unreachable (a `nest start --watch` dev
    // server restarts on every source edit), for up to ~3 minutes
    expect: async (method, p, body, ok = (s) => s >= 200 && s < 300) => {
      let r = await call(method, p, body);
      for (let i = 0; i < 90 && r.status === 0; i++) {
        await new Promise((res) => setTimeout(res, 2000));
        r = await call(method, p, body);
      }
      if (!ok(r.status)) {
        throw new Error(
          `${method} ${p} -> ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`,
        );
      }
      return r.body;
    },
  };
}

/**
 * Sign in as the owner, initialize the store, create `productCount` products and
 * receive `stockPerProduct` units of each at the register's stock location.
 */
export async function setupStore(
  api,
  email,
  { productCount = 5, stockPerProduct = 100000 } = {},
) {
  const login = await api.expect('POST', '/auth/login', {
    email,
    password: PASSWORD,
  });
  if (!login.accessToken)
    throw new Error('login returned no access token (MFA?)');
  api.setToken(login.accessToken);

  const init = await api.expect('POST', '/settings/initialize');
  const context = await api.expect('GET', '/pos/context');
  const registerId = init.register?.id ?? context.registers?.[0]?.id;
  const locationId = init.location?.id;
  const cash = (context.paymentMethods || []).find(
    (m) => m.code === 'CASH' || m.methodType === 'cash',
  );
  if (!registerId || !locationId || !cash) {
    throw new Error(
      'store has no register, stock location or cash method after initialize',
    );
  }

  const variantIds = [];
  for (let i = 1; i <= productCount; i++) {
    const product = await api.expect('POST', '/products', {
      sku: `LT-${i}`,
      name: { en: `Load item ${i}` },
      price: Number((1.25 * i + 0.99).toFixed(2)),
      cost: 0.5 * i,
      allowBackorder: false,
    });
    variantIds.push(product.variants[0].id);
  }
  await api.expect('POST', '/inventory/receive', {
    locationId,
    reference: 'LOAD-PO-1',
    items: variantIds.map((variantId) => ({
      variantId,
      quantity: stockPerProduct,
      cost: 1,
    })),
  });
  return {
    token: login.accessToken,
    registerId,
    locationId,
    cashId: cash.id,
    variantIds,
  };
}

/** JS port of test/helpers/delete-tenant.ts. Uses (and keeps open) the given client. */
export async function deleteTenant(client, tenantId, userIds = new Set()) {
  if (!tenantId) return;
  const {
    rows: [t],
  } = await client.query(`SELECT slug FROM tenants WHERE id = $1`, [tenantId]);
  if (t?.slug === 'default-tenant')
    throw new Error('refusing to delete default-tenant');
  try {
    await client.query(`SELECT set_config('app.audit_purge', 'on', false)`);
    const members = await client.query(
      `SELECT "userId" FROM tenant_memberships WHERE "tenantId" = $1`,
      [tenantId],
    );
    members.rows.forEach((r) => userIds.add(r.userId));

    const tables = await client.query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenantId' AND table_name <> 'tenants'`,
    );
    let remaining = tables.rows.map((r) => r.table_name);
    await client.query(
      `UPDATE categories SET "parentId" = NULL WHERE "tenantId" = $1`,
      [tenantId],
    );
    for (let pass = 0; pass < 12 && remaining.length > 0; pass++) {
      const blocked = [];
      for (const table of remaining) {
        try {
          await client.query(`DELETE FROM "${table}" WHERE "tenantId" = $1`, [
            tenantId,
          ]);
        } catch {
          blocked.push(table); // still referenced by another tenant table
        }
      }
      remaining = blocked;
    }
    if (remaining.length > 0) {
      throw new Error(
        `cleanup could not empty: ${remaining.join(', ')} (tenant ${tenantId})`,
      );
    }
    await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    // Delete triggers on catalog tables (products, variants, stock_levels, registers, ...)
    // append 'D' rows to sync_change_log, possibly after that table was emptied above.
    // It has no FK to tenants, so those rows would be orphaned: clear it last.
    await client.query(`DELETE FROM sync_change_log WHERE "tenantId" = $1`, [
      tenantId,
    ]);
    await client.query(
      `DELETE FROM users WHERE id = ANY($1)
         AND NOT EXISTS (SELECT 1 FROM tenant_memberships m WHERE m."userId" = users.id)`,
      [[...userIds]],
    );
  } finally {
    await client.query(`SELECT set_config('app.audit_purge', '', false)`);
  }
}

/** Rows left anywhere for the tenant (0 = fully deleted) */
export async function tenantLeftovers(client, tenantId, userIds = new Set()) {
  const tables = await client.query(
    `SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenantId' AND table_name <> 'tenants'`,
  );
  let total = 0;
  for (const { table_name } of tables.rows) {
    const r = await client.query(
      `SELECT count(*)::int n FROM "${table_name}" WHERE "tenantId" = $1`,
      [tenantId],
    );
    total += r.rows[0].n;
  }
  const t = await client.query(
    `SELECT count(*)::int n FROM tenants WHERE id = $1`,
    [tenantId],
  );
  const u = await client.query(
    `SELECT count(*)::int n FROM users WHERE id = ANY($1)`,
    [[...userIds]],
  );
  return { tenantRows: total, tenant: t.rows[0].n, users: u.rows[0].n };
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(
    sorted.length - 1,
    Math.ceil((p / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, idx)];
}

export function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return {
    n: s.length,
    min: s[0],
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1],
    mean,
  };
}
