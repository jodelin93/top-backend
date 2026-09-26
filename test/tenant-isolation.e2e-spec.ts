// Must come first: NUMERIC columns are parsed as numbers (same as main.ts)
import '../src/database/pg-types';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { payloadHash } from '../src/sync/payload-hash';
import {
  createStore,
  dropStore,
  listen,
  Method,
  runId,
  stockedProduct,
  Store,
} from './helpers/test-store';

/**
 * Tenant isolation attack (spec §9, AC15 tenant part) against the real database.
 *
 * Two throwaway stores, A and B, each with an owner. Store B has a sale, a
 * return, a customer, a product, a shift, a device, a print job, an export job,
 * a conflict case, a gift card and stock. Store A's OWNER (every permission in
 * their own store) uses B's ids directly: every read/write must answer 403/404
 * without B's data, and no list of A may contain a row of B.
 */

jest.setTimeout(240_000);

const RUN = runId();

describe('Tenant isolation attack (e2e, AC15)', () => {
  let app: INestApplication;
  let dataSource: DataSource;
  let A: Store;
  let B: Store;

  const b = {
    productId: '',
    variantId: '',
    saleId: '',
    saleNumber: '',
    saleItemId: '',
    returnId: '',
    customerId: '',
    shiftId: '',
    deviceId: '',
    printJobId: '',
    exportId: '',
    conflictId: '',
    giftCode: `ISO${RUN.replace(/[^0-9]/g, '').slice(-10)}X`,
    storedValueId: '',
  };

  /** Everything B owns that must never show up for A */
  const secrets = () =>
    [
      b.productId,
      b.variantId,
      b.saleId,
      b.saleNumber,
      b.returnId,
      b.customerId,
      b.shiftId,
      b.deviceId,
      b.printJobId,
      b.exportId,
      b.conflictId,
      b.storedValueId,
      B.registerId,
      B.locationId,
      B.branchId,
      B.tenantId,
      `Secret-${RUN}`,
    ].filter(Boolean);

  const asA = (method: Method, path: string, body?: object) =>
    A.api(method, path, body);

  const expectDenied = (r: { status: number; text: string }, what: string) => {
    if (![403, 404].includes(r.status)) {
      throw new Error(
        `${what}: expected 403/404, got ${r.status} ${r.text.slice(0, 300)}`,
      );
    }
    for (const secret of secrets()) {
      // The ids in the request path may be echoed in a 404 message; data may not
      if (secret === b.saleNumber || secret.startsWith('Secret-')) {
        expect(r.text).not.toContain(secret);
      }
    }
  };

  const expectNoLeak = (r: { status: number; text: string }, what: string) => {
    expect(r.status).toBeLessThan(500);
    // An error envelope echoes the request path (the caller's own input, which may
    // hold B's id they guessed): that is not store data, so leave it out
    let body = r.text;
    if (r.status >= 400) {
      try {
        const envelope = JSON.parse(r.text) as Record<string, unknown>;
        delete envelope.path;
        body = JSON.stringify(envelope);
      } catch {
        // Not JSON: check the raw text
      }
    }
    for (const secret of secrets()) {
      if (body.includes(secret)) {
        throw new Error(
          `${what} leaks store B's ${secret}: ${r.text.slice(0, 300)}`,
        );
      }
    }
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ logger: ['error'] });
    configureApp(app);
    await app.init();
    const baseUrl = await listen(app);
    dataSource = app.get(DataSource);

    [A, B] = await Promise.all([
      createStore(dataSource, baseUrl, 'isoa'),
      createStore(dataSource, baseUrl, 'isob'),
    ]);
    // A has some data of its own, so lists are not trivially empty
    await stockedProduct(A, `ISO-A-${RUN}`, 3, 5);
    await A.api('post', '/customers', {
      firstName: 'Alice',
      lastName: 'Astore',
    });

    // ---- Store B ----
    ({ productId: b.productId, variantId: b.variantId } = await stockedProduct(
      B,
      `ISO-B-${RUN}`,
      10,
      20,
      { name: { en: `Secret-${RUN} product` } },
    ));
    const customer = await B.api('post', '/customers', {
      firstName: `Secret-${RUN}`,
      lastName: 'Bstore',
      email: `secret-${RUN}@example.com`,
    });
    b.customerId = customer.body.id;

    const shift = await B.api('post', '/shifts/open', {
      registerId: B.registerId,
      openingFloat: 50,
    });
    expect(shift.status).toBeLessThan(300);
    b.shiftId = shift.body.id;

    const sale = await B.api('post', '/sales', {
      registerId: B.registerId,
      customerId: b.customerId,
      items: [{ variantId: b.variantId, quantity: 2 }],
      giftCards: [{ amount: 25, code: b.giftCode }],
      payments: [{ paymentMethodId: B.methods.CASH, amount: 50 }],
      idempotencyKey: `iso-b-${RUN}`,
    });
    expect(sale.status).toBe(201);
    b.saleId = sale.body.id;
    b.saleNumber = sale.body.saleNumber;
    b.saleItemId = (
      sale.body.items as { id: string; variantId: string }[]
    ).find((i) => i.variantId === b.variantId)!.id;

    const ret = await B.api('post', '/returns', {
      saleId: b.saleId,
      registerId: B.registerId,
      reason: 'iso',
      items: [
        { saleItemId: b.saleItemId, quantity: 1, disposition: 'restock' },
      ],
      idempotencyKey: `iso-ret-${RUN}`,
    });
    expect(ret.status).toBe(201);
    b.returnId = ret.body.id;

    const device = await B.api('post', '/devices/register', {
      registerId: B.registerId,
      name: `Secret-${RUN} till`,
    });
    expect(device.status).toBeLessThan(300);
    b.deviceId =
      device.body.id ?? device.body.deviceId ?? device.body.device?.id;

    const printJob = await B.api('post', '/print-jobs', {
      documentType: 'receipt',
      documentId: b.saleId,
      channel: 'browser',
    });
    expect(printJob.status).toBeLessThan(300);
    b.printJobId = printJob.body.id ?? printJob.body.job?.id;

    const [{ id: exportId }] = await dataSource.query<{ id: string }[]>(
      `INSERT INTO export_jobs ("tenantId", "userId", "reportKey", params, scope, format,
                                status, "fileKey", "fileName", "finishedAt", "expiresAt")
       VALUES ($1, $2, 'sales-by-day', '{}', NULL, 'csv', 'done', $3, 'secret.csv', now(),
               now() + interval '1 hour')
       RETURNING id`,
      [
        B.tenantId,
        B.ownerId,
        `private/exports/${B.tenantId}/${'b'.repeat(32)}.csv`,
      ],
    );
    b.exportId = exportId;

    const [{ id: conflictId }] = await dataSource.query<{ id: string }[]>(
      `INSERT INTO conflict_cases ("tenantId", type, status, "saleId", details)
       VALUES ($1, 'offline_oversell', 'open', $2, $3) RETURNING id`,
      [B.tenantId, b.saleId, JSON.stringify({ note: `Secret-${RUN}` })],
    );
    b.conflictId = conflictId;

    const [account] = await dataSource.query<{ id: string }[]>(
      `SELECT id FROM stored_value_accounts WHERE "tenantId" = $1 LIMIT 1`,
      [B.tenantId],
    );
    b.storedValueId = account?.id ?? '';

    for (const [k, v] of Object.entries(b)) {
      if (!v) throw new Error(`setup: store B has no ${k}`);
    }
  });

  afterAll(async () => {
    try {
      await dropStore(dataSource, A);
    } finally {
      try {
        await dropStore(dataSource, B);
      } finally {
        await app?.close();
      }
    }
  });

  describe('reads by guessed id are refused', () => {
    const cases: [string, () => string][] = [
      ['sale', () => `/sales/${b.saleId}`],
      ['payments of the sale', () => `/payments/sales/${b.saleId}`],
      ['customer', () => `/customers/${b.customerId}`],
      ['customer account', () => `/customers/${b.customerId}/account`],
      [
        'customer statement',
        () =>
          `/customers/${b.customerId}/account/statement?from=2020-01-01T00:00:00.000Z&to=2030-01-01T00:00:00.000Z`,
      ],
      ['customer activity', () => `/customers/${b.customerId}/activity`],
      ['customer loyalty', () => `/loyalty/customers/${b.customerId}`],
      ['product', () => `/products/${b.productId}`],
      ['product variants', () => `/products/${b.productId}/variants`],
      ['shift', () => `/shifts/${b.shiftId}`],
      ['shift z-report', () => `/shifts/${b.shiftId}/z-report`],
      ['shift ledger', () => `/shifts/${b.shiftId}/ledger`],
      ['return', () => `/returns/${b.returnId}`],
      ['export job', () => `/exports/${b.exportId}`],
      ['device', () => `/devices/${b.deviceId}`],
      ['register', () => `/registers/${B.registerId}`],
      ['location', () => `/locations/${B.locationId}`],
      ['branch', () => `/branches/${B.branchId}`],
      ['stored value account', () => `/stored-value/${b.storedValueId}`],
      [
        'gift card by code',
        () => `/stored-value/gift-cards/lookup?code=${b.giftCode}`,
      ],
      [
        'sync changes of B register',
        () => `/sync/changes?registerId=${B.registerId}`,
      ],
    ];
    it.each(cases)('%s', async (what, path) => {
      expectDenied(await asA('get', path()), what);
    });

    it("whatever sync changes answers for B's register, it holds none of B's data", async () => {
      expectNoLeak(
        await asA('get', `/sync/changes?registerId=${B.registerId}`),
        'sync changes',
      );
    });

    it('store credit of B customer is not revealed', async () => {
      const r = await asA('get', `/stored-value/customers/${b.customerId}`);
      if (r.status === 200) {
        expect(r.body.account).toBeNull();
      } else {
        expectDenied(r, 'store credit');
      }
    });

    it("print jobs of B's sale are not listed", async () => {
      const r = await asA(
        'get',
        `/print-jobs?documentType=receipt&documentId=${b.saleId}`,
      );
      if (r.status === 200) expect(r.body).toEqual([]);
      else expectDenied(r, 'print jobs');
    });

    it("receipt deliveries of B's sale are not listed", async () => {
      const r = await asA(
        'get',
        `/documents/deliveries?documentId=${b.saleId}`,
      );
      if (r.status === 200) expect(r.body).toEqual([]);
      else expectDenied(r, 'deliveries');
    });

    it("stock and movements at B's location are not visible", async () => {
      const stock = await asA(
        'get',
        `/inventory/stock?locationId=${B.locationId}`,
      );
      if (stock.status === 200) expect(stock.body).toEqual([]);
      else expectDenied(stock, 'stock');
      const movements = await asA(
        'get',
        `/inventory/movements?locationId=${B.locationId}`,
      );
      if (movements.status === 200) expect(movements.body).toEqual([]);
      else expectDenied(movements, 'movements');
      const byVariant = await asA(
        'get',
        `/inventory/movements?variantId=${b.variantId}`,
      );
      expectNoLeak(byVariant, 'movements by variant');
    });

    it("B's export file is not downloadable through storage", async () => {
      const r = await asA(
        'get',
        `/storage/files/private/exports/${B.tenantId}/${'b'.repeat(32)}.csv`,
      );
      expect([400, 401, 403, 404]).toContain(r.status);
    });
  });

  describe('writes by guessed id are refused', () => {
    const cases: [string, Method, () => string, () => object | undefined][] = [
      [
        'void sale',
        'post',
        () => `/sales/${b.saleId}/void`,
        () => ({ reason: 'x' }),
      ],
      [
        'reprint sale',
        'post',
        () => `/sales/${b.saleId}/reprint`,
        () => undefined,
      ],
      [
        'share receipt',
        'post',
        () => `/documents/receipts/${b.saleId}/share-link`,
        () => ({}),
      ],
      [
        'email receipt',
        'post',
        () => `/documents/receipts/${b.saleId}/email`,
        () => ({ to: 'x@example.com' }),
      ],
      [
        'update customer',
        'patch',
        () => `/customers/${b.customerId}`,
        () => ({ firstName: 'Hacked' }),
      ],
      [
        'adjust points',
        'post',
        () => `/loyalty/customers/${b.customerId}/adjust`,
        () => ({ points: 100, note: 'x' }),
      ],
      [
        'credit customer',
        'post',
        () => `/stored-value/customers/${b.customerId}/credit`,
        () => ({ amount: 5, reason: 'x' }),
      ],
      [
        'customer payment',
        'post',
        () => `/customers/${b.customerId}/account/payments`,
        () => ({ amount: 5, paymentMethodId: A.methods.CARD }),
      ],
      [
        'update product',
        'patch',
        () => `/products/${b.productId}`,
        () => ({ price: 0.01 }),
      ],
      [
        'delete product',
        'delete',
        () => `/products/${b.productId}`,
        () => undefined,
      ],
      [
        'close shift',
        'post',
        () => `/shifts/${b.shiftId}/close`,
        () => ({ countedCash: 0, idempotencyKey: `iso-close-${RUN}` }),
      ],
      [
        'cash movement',
        'post',
        () => `/shifts/${b.shiftId}/movements`,
        () => ({ type: 'paid_out', amount: 5, reason: 'xx' }),
      ],
      [
        'retry refund',
        'post',
        () => `/returns/${b.returnId}/retry-refunds`,
        () => ({}),
      ],
      [
        'delete export',
        'delete',
        () => `/exports/${b.exportId}`,
        () => undefined,
      ],
      [
        'update print job',
        'patch',
        () => `/print-jobs/${b.printJobId}`,
        () => ({ status: 'printed' }),
      ],
      [
        'retry print job',
        'post',
        () => `/print-jobs/${b.printJobId}/retry`,
        () => ({}),
      ],
      [
        'resolve conflict',
        'post',
        () => `/conflict-cases/${b.conflictId}/resolve`,
        () => ({ status: 'dismissed', note: 'x' }),
      ],
      [
        'revoke device',
        'post',
        () => `/devices/${b.deviceId}/revoke`,
        () => ({ reason: 'x' }),
      ],
      [
        'heartbeat device',
        'post',
        () => `/devices/${b.deviceId}/heartbeat`,
        () => ({ pendingSales: 0 }),
      ],
      [
        'adjust stored value',
        'post',
        () => `/stored-value/${b.storedValueId}/adjust`,
        () => ({ amount: -5, reason: 'x' }),
      ],
    ];
    it.each(cases)('%s', async (what, method, path, body) => {
      expectDenied(await asA(method, path(), body()), what);
    });

    it("can't sell on B's register or with B's product", async () => {
      const onB = await asA('post', '/sales', {
        registerId: B.registerId,
        items: [{ variantId: b.variantId, quantity: 1 }],
        payments: [{ paymentMethodId: A.methods.CASH, amount: 10 }],
        idempotencyKey: `iso-a-on-b-${RUN}`,
      });
      expect([400, 403, 404]).toContain(onB.status);
      const bProductOnA = await asA('post', '/sales', {
        registerId: A.registerId,
        items: [{ variantId: b.variantId, quantity: 1 }],
        payments: [{ paymentMethodId: A.methods.CASH, amount: 10 }],
        idempotencyKey: `iso-a-b-prod-${RUN}`,
      });
      expect([400, 403, 404]).toContain(bProductOnA.status);
      const bMethod = await asA('post', '/sales', {
        registerId: A.registerId,
        items: [],
        giftCards: [{ amount: 5 }],
        payments: [{ paymentMethodId: B.methods.CASH, amount: 5 }],
        idempotencyKey: `iso-a-b-method-${RUN}`,
      });
      expect([400, 403, 404]).toContain(bMethod.status);
    });

    it("can't spend B's gift card", async () => {
      const r = await asA('post', '/sales', {
        registerId: A.registerId,
        items: [],
        giftCards: [{ amount: 5 }],
        payments: [
          {
            paymentMethodId: A.methods.GIFT_CARD,
            amount: 5,
            giftCardCode: b.giftCode,
          },
        ],
        idempotencyKey: `iso-a-gc-${RUN}`,
      });
      expect([400, 403, 404]).toContain(r.status);
    });

    it("can't return B's sale or move B's stock", async () => {
      const ret = await asA('post', '/returns', {
        saleId: b.saleId,
        registerId: A.registerId,
        reason: 'iso',
        items: [
          { saleItemId: b.saleItemId, quantity: 1, disposition: 'restock' },
        ],
        idempotencyKey: `iso-a-ret-${RUN}`,
      });
      expect([400, 403, 404]).toContain(ret.status);
      const adjust = await asA('post', '/inventory/adjustments', {
        locationId: B.locationId,
        reason: 'recount',
        mode: 'set',
        items: [{ variantId: b.variantId, quantity: 0 }],
      });
      expect([400, 403, 404]).toContain(adjust.status);
      const receive = await asA('post', '/inventory/receive', {
        locationId: B.locationId,
        items: [{ variantId: b.variantId, quantity: 1 }],
      });
      expect([400, 403, 404]).toContain(receive.status);
      const transfer = await asA('post', '/inventory/transfers', {
        fromLocationId: B.locationId,
        toLocationId: A.locationId,
        items: [{ variantId: b.variantId, quantity: 1 }],
      });
      expect([400, 403, 404]).toContain(transfer.status);
    });

    it("can't enroll a till on B's register", async () => {
      const enroll = await asA('post', '/devices/register', {
        registerId: B.registerId,
      });
      if (![400, 403, 404].includes(enroll.status)) {
        throw new Error(
          `expected 400/403/404, got ${enroll.status} ${enroll.text.slice(0, 600)}`,
        );
      }
    });

    it("re-registering B's device id doesn't hand it to A", async () => {
      const reuse = await asA('post', '/devices/register', {
        deviceId: b.deviceId,
        registerId: A.registerId,
      });
      if (reuse.status < 300) {
        const id =
          reuse.body.id ?? reuse.body.deviceId ?? reuse.body.device?.id;
        expect(id).not.toBe(b.deviceId);
      }
    });

    it("sync push as B's device is refused", async () => {
      const push = await asA('post', '/sync/push', {
        deviceId: b.deviceId,
        operations: [
          {
            deviceOperationId: `iso-op-${RUN}`,
            deviceSequence: 1,
            type: 'sale.create',
            schemaVersion: 1,
            payloadHash: '0'.repeat(64),
            payload: { registerId: B.registerId },
          },
        ],
      });
      if (![400, 403, 404].includes(push.status)) {
        throw new Error(
          `expected 400/403/404, got ${push.status} ${push.text.slice(0, 600)}`,
        );
      }
    });

    it("an offline sale pushed for B's register is never applied", async () => {
      const payload = {
        registerId: B.registerId,
        items: [{ variantId: b.variantId, quantity: 1, unitPrice: 10 }],
        payments: [{ paymentMethodId: B.methods.CASH, amount: 10 }],
        offlineCapturedAt: new Date(Date.now() - 60_000).toISOString(),
      };
      const push = await asA('post', '/sync/push', {
        operations: [
          {
            deviceOperationId: `iso-op2-${RUN}`,
            deviceSequence: 2,
            type: 'sale.create',
            schemaVersion: 1,
            payloadHash: payloadHash(payload),
            payload,
          },
        ],
      });
      expect(push.status).toBeLessThan(500);
      if (push.status < 300) {
        const [ack] = push.body.results as { status: string }[];
        expect(['needs_review', 'rejected']).toContain(ack.status);
      }
      const [{ n }] = await dataSource.query<{ n: number }[]>(
        `SELECT COUNT(*)::int AS n FROM sales WHERE "registerId" = $1`,
        [B.registerId],
      );
      expect(n).toBe(1);
    });

    it("no offline lease for B's device", async () => {
      const lease = await asA('post', `/devices/${b.deviceId}/lease`, {});
      expect([400, 403, 404]).toContain(lease.status);
    });

    it("can't switch into store B", async () => {
      const r = await asA('post', '/auth/switch-store', {
        tenantId: B.tenantId,
      });
      expect([400, 401, 403, 404]).toContain(r.status);
    });

    it('nothing of B changed', async () => {
      const sale = await B.api('get', `/sales/${b.saleId}`);
      expect(sale.body.status).not.toBe('voided');
      const product = await B.api('get', `/products/${b.productId}`);
      expect(product.body.variants[0].price).toBe(10);
      const shift = await B.api('get', `/shifts/${b.shiftId}`);
      expect(shift.body.status).toBe('open');
      const [conflict] = await dataSource.query<{ status: string }[]>(
        `SELECT status FROM conflict_cases WHERE id = $1`,
        [b.conflictId],
      );
      expect(conflict.status).toBe('open');
      const [points] = await dataSource.query<{ loyaltyPoints: number }[]>(
        `SELECT "loyaltyPoints" FROM customers WHERE id = $1`,
        [b.customerId],
      );
      const customer = await B.api('get', `/customers/${b.customerId}`);
      expect(customer.body.firstName).toBe(`Secret-${RUN}`);
      expect(Number(points.loyaltyPoints)).toBe(
        Number(customer.body.loyaltyPoints),
      );
      const [{ n }] = await dataSource.query<{ n: number }[]>(
        `SELECT COUNT(*)::int AS n FROM sales WHERE "registerId" = $1`,
        [B.registerId],
      );
      expect(n).toBe(1);
      const [device] = await dataSource.query<{ revokedAt: Date | null }[]>(
        `SELECT "revokedAt" FROM devices WHERE id = $1`,
        [b.deviceId],
      );
      expect(device.revokedAt).toBeNull();
    });
  });

  describe("lists never include B's rows", () => {
    const lists = [
      '/sales?limit=100',
      '/sales/held',
      '/customers',
      '/customers?search=Secret',
      '/customers/duplicates',
      '/products',
      '/products?search=Secret',
      '/shifts',
      '/returns',
      '/returns/exchanges',
      '/exports',
      '/conflict-cases',
      '/devices',
      '/devices/summary',
      '/stored-value',
      '/inventory/stock',
      '/inventory/movements',
      '/inventory/transfers',
      '/inventory/counts',
      '/registers',
      '/locations',
      '/branches',
      '/warehouses',
      '/payment-methods',
      '/audit-logs',
      '/notifications',
      '/goods-receipts',
      '/purchase-orders',
      '/suppliers',
      '/discounts',
      '/employees',
      '/users',
      '/sync/changes',
      '/customer-accounts/aging',
      '/system-events/outbox',
      '/pos/catalog?search=Secret',
      '/pos/context',
    ];
    it.each(lists)('%s', async (path) => {
      expectNoLeak(await asA('get', path), path);
    });

    it('reports and exports cover only A', async () => {
      const from = new Date(Date.now() - 86_400_000).toISOString();
      const to = new Date(Date.now() + 86_400_000).toISOString();
      for (const path of [
        `/reports/summary?from=${from}&to=${to}`,
        `/reports/sales-by-day?from=${from}&to=${to}`,
        `/reports/sales-by-day/export?format=csv&from=${from}&to=${to}`,
        `/reports/reconciliation?from=${from}&to=${to}`,
      ]) {
        const r = await asA('get', path);
        expectNoLeak(r, path);
        // A sold nothing: no revenue may appear (B sold 20.00 + a 25.00 gift card)
        if (
          r.status === 200 &&
          typeof r.body === 'object' &&
          r.body?.totalSales !== undefined
        ) {
          expect(Number(r.body.totalSales)).toBe(0);
        }
      }
    });
  });
});
