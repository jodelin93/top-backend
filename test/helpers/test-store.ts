import { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { deleteTenant } from './delete-tenant';

/**
 * A throwaway store for e2e tests, created straight in the database (like
 * app.e2e-spec.ts) and set up through the API. `baseUrl` is a listening
 * in-process server (app.listen(0)), so requests can really run in parallel.
 */

export type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
export const PASSWORD = 'TestPass123!';

export interface Store {
  label: string;
  tenantId: string;
  ownerId: string;
  token: string;
  registerId: string;
  locationId: string;
  branchId: string;
  methods: Record<string, string>;
  userIds: Set<string>;
  api: (
    method: Method,
    path: string,
    body?: object,
    options?: { token?: string | null; headers?: Record<string, string> },
  ) => request.Test;
}

export const runId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export async function listen(app: INestApplication): Promise<string> {
  await app.listen(0, '127.0.0.1');
  const server = app.getHttpServer() as {
    address: () => { port: number };
  };
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

export function apiFor(baseUrl: string, defaultToken: () => string | null) {
  return (
    method: Method,
    path: string,
    body?: object,
    options: { token?: string | null; headers?: Record<string, string> } = {},
  ) => {
    // API-client mode: the token comes back in the body (no cookie) and the
    // header also satisfies the anti-CSRF check (auth/guards/csrf.guard.ts)
    let req = request(baseUrl)
      [method](`/api/v1${path}`)
      .set('X-Auth-Mode', 'token');
    const bearer = options.token === undefined ? defaultToken() : options.token;
    if (bearer) req = req.set('Authorization', `Bearer ${bearer}`);
    for (const [k, v] of Object.entries(options.headers ?? {})) {
      req = req.set(k, v);
    }
    return body ? req.send(body) : req;
  };
}

/** Create a store with an owner, initialise it and sign the owner in */
export async function createStore(
  dataSource: DataSource,
  baseUrl: string,
  label: string,
): Promise<Store> {
  const run = runId();
  const slug = `e2e-${label}-${run}`
    .toLowerCase()
    .slice(0, 50)
    .replace(/-+$/, '');
  const [tenant] = await dataSource.query<{ id: string }[]>(
    `INSERT INTO tenants (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
    [`E2E ${label} ${run}`, slug],
  );
  const email = `e2e-${label}-${run}@test.local`.toLowerCase();
  const [owner] = await dataSource.query<{ id: string }[]>(
    `INSERT INTO users (email, "passwordHash", "firstName", "lastName")
     VALUES ($1, $2, 'E2E', 'Owner') RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 4)],
  );
  await dataSource.query(
    `INSERT INTO tenant_memberships ("tenantId", "userId", status, role)
     VALUES ($1, $2, 'active', 'owner')`,
    [tenant.id, owner.id],
  );

  const store = {
    label,
    tenantId: tenant.id,
    ownerId: owner.id,
    token: '',
    userIds: new Set([owner.id]),
    methods: {},
  } as unknown as Store;
  store.api = apiFor(baseUrl, () => store.token);

  const login = await store.api(
    'post',
    '/auth/login',
    { email, password: PASSWORD },
    { token: null },
  );
  if (login.status !== 200) {
    throw new Error(
      `login failed: ${login.status} ${JSON.stringify(login.body)}`,
    );
  }
  store.token = login.body.accessToken;

  const init = await store.api('post', '/settings/initialize');
  if (init.status >= 300) {
    throw new Error(
      `initialize failed: ${init.status} ${JSON.stringify(init.body)}`,
    );
  }
  store.registerId = init.body.register.id;
  store.locationId = init.body.location.id;
  store.branchId = init.body.register.branchId;

  const context = await store.api('get', '/pos/context');
  for (const m of context.body.paymentMethods as {
    id: string;
    code: string;
  }[]) {
    store.methods[m.code] = m.id;
  }
  return store;
}

export async function dropStore(dataSource: DataSource, store?: Store) {
  if (store?.tenantId && dataSource?.isInitialized) {
    await deleteTenant(dataSource, store.tenantId, store.userIds);
  }
}

/** A simple product (no tax category), stocked at the store's location */
export async function stockedProduct(
  store: Store,
  sku: string,
  price: number,
  stock: number,
  extra: object = {},
): Promise<{ productId: string; variantId: string }> {
  const product = await store.api('post', '/products', {
    sku,
    name: { en: `Item ${sku}` },
    price,
    cost: 1,
    ...extra,
  });
  if (product.status !== 201) {
    throw new Error(
      `product failed: ${product.status} ${JSON.stringify(product.body)}`,
    );
  }
  const variantId = product.body.variants[0].id as string;
  if (stock > 0) {
    const r = await store.api('post', '/inventory/receive', {
      locationId: store.locationId,
      reference: 'E2E',
      items: [{ variantId, quantity: stock, cost: 1 }],
    });
    if (r.status >= 300) {
      throw new Error(`receive failed: ${r.status} ${JSON.stringify(r.body)}`);
    }
  }
  return { productId: product.body.id, variantId };
}

/** On hand at a location, straight from the stock levels */
export async function onHand(
  dataSource: DataSource,
  tenantId: string,
  variantId: string,
  locationId: string,
): Promise<number> {
  const rows = await dataSource.query<{ q: string | number | null }[]>(
    `SELECT "quantityOnHand" AS q FROM stock_levels
     WHERE "tenantId" = $1 AND "variantId" = $2 AND "locationId" = $3`,
    [tenantId, variantId, locationId],
  );
  return Number(rows[0]?.q ?? 0);
}

/** Net of the append-only ledger at a location (in − out) */
export async function ledgerBalance(
  dataSource: DataSource,
  tenantId: string,
  variantId: string,
  locationId: string,
): Promise<number> {
  const [row] = await dataSource.query<{ q: string | number | null }[]>(
    `SELECT COALESCE(SUM(CASE WHEN "toLocationId" = $3 THEN quantity ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN "fromLocationId" = $3 THEN quantity ELSE 0 END), 0) AS q
     FROM stock_movements WHERE "tenantId" = $1 AND "variantId" = $2
       AND ("toLocationId" = $3 OR "fromLocationId" = $3)`,
    [tenantId, variantId, locationId],
  );
  return Number(row.q ?? 0);
}

/** Add a staff member with a role and sign them in */
export async function addMember(
  store: Store,
  role: string,
): Promise<{ id: string; token: string }> {
  const email =
    `e2e-${store.label}-${role}-${runId()}@test.local`.toLowerCase();
  const r = await store.api('post', '/users', {
    email,
    password: PASSWORD,
    firstName: 'E2E',
    lastName: role,
    role,
  });
  if (r.status !== 201) {
    throw new Error(`add member failed: ${r.status} ${JSON.stringify(r.body)}`);
  }
  const id = (r.body.id ?? r.body.user?.id ?? r.body.userId) as string;
  store.userIds.add(id);
  const login = await store.api(
    'post',
    '/auth/login',
    { email, password: PASSWORD },
    { token: null },
  );
  return { id, token: login.body.accessToken };
}

/** Status codes of settled parallel requests */
export const statuses = (responses: { status: number }[]) =>
  responses.map((r) => r.status).sort();
