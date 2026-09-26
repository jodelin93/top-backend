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
import { payloadHash } from '../src/sync/payload-hash';

/**
 * End-to-end API test against the real database configured in .env.
 *
 * It creates its own throwaway tenant + owner directly in the database, drives
 * the whole POS flow through HTTP, and deletes everything belonging to that
 * tenant in afterAll (even when tests fail). No other tenant's data is touched.
 * Slugs and emails carry a per-run suffix so concurrent runs don't clash.
 */

const RUN = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const OWNER_EMAIL = `e2e-owner-${RUN}@test.local`;
const OWNER_PASSWORD = 'TestPass123!';
const CASHIER_EMAIL = `e2e-cashier-${RUN}@test.local`;
const CASHIER_PASSWORD = 'Cashier123!';

jest.setTimeout(60_000);

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

describe('POS API (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let tenantId: string | undefined;
  const createdUserIds = new Set<string>();

  // Tokens and ids shared by the steps below (they run in order)
  let token: string;
  let cashierToken: string;
  let registerId: string;
  let locationId: string;
  let cash: string;
  let card: string;
  let categoryId: string;
  let coffee: string;
  let coffeeProduct: string;
  let tea: string;
  let customerId: string;
  let sale: { id: string; user: Record<string, unknown> };
  let cashierId: string;
  const key = `e2e-${RUN}`;

  const api = (
    method: Method,
    path: string,
    body?: object,
    bearer: string | null = token,
  ) => {
    let req = request(app.getHttpServer())[method](`/api/v1${path}`);
    if (bearer) req = req.set('Authorization', `Bearer ${bearer}`);
    return body ? req.send(body) : req;
  };

  const stockOf = async (search: string) => {
    const r = await api(
      'get',
      `/inventory/stock?locationId=${locationId}&search=${search}`,
    );
    return r.body[0]?.quantityOnHand as number | undefined;
  };

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication({ logger: ['error'] });
    // Exactly the server's request pipeline (src/app.setup.ts)
    configureApp(app);
    await app.init();

    // Throwaway tenant + owner, created straight in the database
    dataSource = app.get(DataSource);
    const [tenant] = await dataSource.query<{ id: string }[]>(
      `INSERT INTO tenants (name, slug, status) VALUES ($1, $2, 'active') RETURNING id`,
      [`E2E Test Store ${RUN}`, `e2e-test-store-${RUN}`],
    );
    tenantId = tenant.id;
    const [owner] = await dataSource.query<{ id: string }[]>(
      `INSERT INTO users (email, "passwordHash", "firstName", "lastName")
       VALUES ($1, $2, 'E2E', 'Owner') RETURNING id`,
      [OWNER_EMAIL, await bcrypt.hash(OWNER_PASSWORD, 4)],
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

  describe('auth', () => {
    it('logs the owner in with their tenant and role', async () => {
      const r = await api(
        'post',
        '/auth/login',
        { email: OWNER_EMAIL, password: OWNER_PASSWORD },
        null,
      );
      expect(r.status).toBe(200);
      expect(r.body.user).toMatchObject({ role: 'owner', tenantId });
      token = r.body.accessToken;
    });

    it('rejects a wrong password', async () => {
      const r = await api(
        'post',
        '/auth/login',
        { email: OWNER_EMAIL, password: 'nope-nope' },
        null,
      );
      expect(r.status).toBe(401);
    });

    it('returns the profile without the password hash', async () => {
      const r = await api('post', '/auth/me');
      expect(r.body.role).toBe('owner');
      expect(r.body).not.toHaveProperty('passwordHash');
    });

    it('rejects unauthenticated requests', async () => {
      const r = await api('get', '/products', undefined, null);
      expect(r.status).toBe(401);
    });
  });

  describe('store setup', () => {
    it('initializes default branch, location, register and payment methods', async () => {
      const r = await api('post', '/settings/initialize');
      expect(r.status).toBeLessThan(300);
      registerId = r.body.register.id;
      locationId = r.body.location.id;
      expect(registerId).toBeDefined();
      expect(locationId).toBeDefined();
    });

    it('is idempotent', async () => {
      const r = await api('post', '/settings/initialize');
      expect(r.body.register.id).toBe(registerId);
    });

    it('sets a default tax rate', async () => {
      const tax = await api('post', '/tax-rates', {
        code: 'VAT10',
        name: { en: 'VAT 10%' },
        rate: 10,
      });
      expect(tax.status).toBe(201);
      const r = await api('patch', '/settings', {
        defaultTaxRateId: tax.body.id,
        currencyCode: 'USD',
        receiptFooter: 'Thanks!',
      });
      expect(r.body.defaultTaxRateId).toBe(tax.body.id);
    });

    it('rejects unknown fields (forbidNonWhitelisted)', async () => {
      const r = await api('post', '/tax-rates', {
        code: 'X',
        name: { en: 'X' },
        rate: 1,
        hacker: true,
      });
      expect(r.status).toBe(400);
    });

    it('exposes the POS context', async () => {
      const r = await api('get', '/pos/context');
      expect(r.status).toBe(200);
      expect(r.body.taxRate).toBe(10);
      expect(r.body.registers).toHaveLength(1);
      const methods = r.body.paymentMethods as { id: string; code: string }[];
      // Cash and card from the default setup, loyalty points (programme on by default)
      // and the stored-value / on-account tenders (D019)
      expect(methods.map((m) => m.code).sort()).toEqual([
        'CARD',
        'CASH',
        'GIFT_CARD',
        'LOYALTY',
        'ON_ACCOUNT',
        'STORE_CREDIT',
      ]);
      cash = methods.find((m) => m.code === 'CASH')!.id;
      card = methods.find((m) => m.code === 'CARD')!.id;
    });
  });

  describe('catalog', () => {
    it('creates categories and rejects cycles', async () => {
      let r = await api('post', '/categories', {
        code: 'DRINKS',
        name: { en: 'Drinks' },
      });
      expect(r.status).toBe(201);
      categoryId = r.body.id;

      r = await api('post', '/categories', {
        code: 'HOT',
        name: { en: 'Hot drinks' },
        parentId: categoryId,
      });
      expect(r.body.parentId).toBe(categoryId);

      r = await api('patch', `/categories/${categoryId}`, {
        parentId: r.body.id,
      });
      expect(r.status).toBe(400);
    });

    it('rejects a duplicate category code', async () => {
      const r = await api('post', '/categories', {
        code: 'DRINKS',
        name: { en: 'Again' },
      });
      expect(r.status).toBe(409);
    });

    it('creates a simple product with a default variant', async () => {
      const r = await api('post', '/products', {
        sku: 'COF-1',
        name: { en: 'Coffee' },
        categoryId,
        price: 4.5,
        cost: 1.2,
        allowBackorder: false,
        barcode: '111',
      });
      expect(r.status).toBe(201);
      expect(r.body.variants).toHaveLength(1);
      expect(r.body.variants[0].price).toBe(4.5);
      expect(r.body.category.id).toBe(categoryId);
      coffee = r.body.variants[0].id;
      coffeeProduct = r.body.id;

      const teaRes = await api('post', '/products', {
        sku: 'TEA-1',
        name: { en: 'Tea' },
        price: 3,
      });
      tea = teaRes.body.variants[0].id;
    });

    it('keeps the default variant price in sync', async () => {
      const r = await api('patch', `/products/${coffeeProduct}`, { price: 5 });
      expect(r.body.variants[0].price).toBe(5);
    });

    it('supports variable products with explicit variants', async () => {
      let r = await api('post', '/products', {
        sku: 'SHIRT',
        name: { en: 'Shirt' },
        productType: 'variable',
      });
      expect(r.body.variants).toHaveLength(0);
      const shirtId = r.body.id as string;

      r = await api('post', `/products/${shirtId}/variants`, {
        sku: 'SHIRT-M',
        name: { en: 'Medium' },
        price: 20,
      });
      expect(r.body.price).toBe(20);

      r = await api('post', `/products/${shirtId}/variants`, {
        sku: 'COF-1',
        price: 1,
      });
      expect(r.status).toBe(409);
    });
  });

  describe('stock', () => {
    it('receives stock', async () => {
      const r = await api('post', '/inventory/receive', {
        locationId,
        reference: 'PO-1',
        items: [
          { variantId: coffee, quantity: 10, cost: 1.5 },
          { variantId: tea, quantity: 5 },
        ],
      });
      expect(r.status).toBeLessThan(300);
      expect(await stockOf('COF')).toBe(10);
    });

    it('records a recount adjustment with a document number', async () => {
      const r = await api('post', '/inventory/adjustments', {
        locationId,
        reason: 'recount',
        mode: 'set',
        items: [{ variantId: tea, quantity: 4 }],
      });
      expect(r.body.items[0]).toMatchObject({ before: 5, after: 4 });
      expect(r.body.adjustmentNumber).toMatch(/^ADJ-\d{6}$/);
    });
  });

  describe('customers and discounts', () => {
    it('creates a customer with a generated code and finds them', async () => {
      let r = await api('post', '/customers', {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
      });
      expect(r.body.code).toMatch(/^CUST-\d{6}$/);
      customerId = r.body.id;

      r = await api('get', '/customers?search=lovelace');
      expect(r.body).toHaveLength(1);
    });

    it('creates discount codes (uppercased)', async () => {
      let r = await api('post', '/discounts', {
        code: 'save10',
        name: { en: '10% off' },
        discountType: 'percentage',
        scope: 'cart',
        percentage: 10,
        usageLimit: 1,
      });
      expect(r.body.code).toBe('SAVE10');

      r = await api('post', '/discounts', {
        code: 'COFB2G1',
        name: { en: 'Coffee 2+1' },
        discountType: 'buy_x_get_y',
        scope: 'product',
        buyQuantity: 2,
        getQuantity: 1,
        applicableProductIds: [coffeeProduct],
      });
      expect(r.status).toBe(201);
    });

    it('validates the discount shape', async () => {
      const r = await api('post', '/discounts', {
        code: 'BROKEN',
        name: { en: 'Broken' },
        discountType: 'percentage',
        scope: 'cart',
      });
      expect(r.status).toBe(400);
    });
  });

  describe('selling', () => {
    it('finds products by barcode with price and stock', async () => {
      const r = await api(
        'get',
        `/pos/catalog?registerId=${registerId}&barcode=111`,
      );
      expect(r.body).toHaveLength(1);
      expect(r.body[0]).toMatchObject({ price: 5, stock: 10 });
    });

    it('quotes a cart with a cart % discount and tax', async () => {
      const r = await api('post', '/sales/quote', {
        registerId,
        items: [
          { variantId: coffee, quantity: 2 },
          { variantId: tea, quantity: 1 },
        ],
        discountCode: 'save10',
      });
      // 2×5 + 3 = 13, −10% = 11.70, +10% tax = 12.87
      expect(r.body).toMatchObject({
        subtotal: 13,
        discountAmount: 1.3,
        taxAmount: 1.17,
        total: 12.87,
      });
    });

    it('quotes buy 2 get 1', async () => {
      const r = await api('post', '/sales/quote', {
        registerId,
        items: [{ variantId: coffee, quantity: 3 }],
        discountCode: 'COFB2G1',
      });
      expect(r.body).toMatchObject({ discountAmount: 5, total: 11 });
    });

    const saleBody = () => ({
      registerId,
      customerId,
      items: [
        { variantId: coffee, quantity: 2 },
        { variantId: tea, quantity: 1 },
      ],
      discountCode: 'SAVE10',
      payments: [{ paymentMethodId: cash, amount: 20 }],
      idempotencyKey: key,
    });

    it('completes a cash sale with change', async () => {
      const r = await api('post', '/sales', saleBody());
      expect(r.status).toBe(201);
      expect(r.body).toMatchObject({ total: 12.87, changeAmount: 7.13 });
      // Numbered per branch with the branch code (D017)
      expect(r.body.saleNumber).toMatch(/^[A-Z0-9]+-\d{6}$/);
      expect(r.body.items).toHaveLength(2);
      sale = r.body;
      // The cashier is included for the receipt, but never their password hash
      expect(sale.user).toBeDefined();
      expect(sale.user).not.toHaveProperty('passwordHash');
    });

    it('returns the same sale when the same idempotency key is resubmitted', async () => {
      const r = await api('post', '/sales', saleBody());
      expect(r.body.id).toBe(sale.id);
    });

    it('enforces the discount usage limit', async () => {
      const r = await api('post', '/sales', {
        ...saleBody(),
        idempotencyKey: `${key}-b`,
      });
      expect(r.status).toBe(400);
    });

    it('rejects a card overpayment', async () => {
      const r = await api('post', '/sales', {
        registerId,
        items: [{ variantId: coffee, quantity: 1 }],
        payments: [{ paymentMethodId: card, amount: 10 }],
      });
      expect(r.status).toBe(400);
    });

    it('rejects an underpayment', async () => {
      const r = await api('post', '/sales', {
        registerId,
        items: [{ variantId: coffee, quantity: 1 }],
        payments: [{ paymentMethodId: card, amount: 1 }],
      });
      expect(r.status).toBe(400);
    });

    it('rejects selling more than is in stock (no backorder)', async () => {
      const r = await api('post', '/sales', {
        registerId,
        items: [{ variantId: coffee, quantity: 50 }],
        payments: [{ paymentMethodId: cash, amount: 1000 }],
      });
      expect(r.status).toBe(400);
      expect(String(r.body.message)).toMatch(/stock/i);
    });

    it('took the sold items out of stock and awarded loyalty points', async () => {
      expect(await stockOf('COF')).toBe(8);
      const r = await api('get', `/customers/${customerId}`);
      expect(r.body.loyaltyPoints).toBe(12);
    });

    it('refuses offline fields on POST /sales (only the till upload has them)', async () => {
      const r = await api('post', '/sales', {
        registerId,
        items: [{ variantId: tea, quantity: 10, unitPrice: 2.5 }],
        payments: [{ paymentMethodId: cash, amount: 30 }],
        offlineCapturedAt: new Date(Date.now() - 3600e3).toISOString(),
        idempotencyKey: `${key}-off-online`,
      });
      expect(r.status).toBe(400);
    });

    it('accepts an offline sale at the price charged, even past zero stock', async () => {
      const payload = {
        registerId,
        items: [{ variantId: tea, quantity: 10, unitPrice: 2.5 }],
        payments: [{ paymentMethodId: cash, amount: 30 }],
        offlineCapturedAt: new Date(Date.now() - 3600e3).toISOString(),
        idempotencyKey: `${key}-off`,
      };
      let r = await api('post', '/sync/push', {
        operations: [
          {
            deviceOperationId: `${key}-off`,
            deviceSequence: 1,
            type: 'sale.create',
            schemaVersion: 1,
            payloadHash: payloadHash(payload),
            payload,
          },
        ],
      });
      expect(r.status).toBe(200);
      expect(r.body.results[0].status).toBe('accepted');
      r = await api('get', `/sales/${r.body.results[0].saleId}`);
      expect(Number(r.body.items[0].unitPrice)).toBe(2.5);
      expect(Number(r.body.total)).toBe(27.5);
    });

    it('applies a promotional price list', async () => {
      let r = await api('post', '/price-lists', {
        code: 'PROMO',
        name: { en: 'Promo' },
        priceListType: 'promotional',
        currencyCode: 'USD',
        priority: 10,
      });
      expect(r.status).toBe(201);

      r = await api('put', `/price-lists/${r.body.id}/entries`, {
        entries: [{ variantId: coffee, price: 3.99 }],
      });
      expect(r.body).toHaveLength(1);

      r = await api(
        'get',
        `/pos/catalog?registerId=${registerId}&search=Coffee`,
      );
      expect(r.body[0].price).toBe(3.99);
    });
  });

  describe('voids and reports', () => {
    it('voids a sale once and restocks it', async () => {
      let r = await api('post', `/sales/${sale.id}/void`, {
        reason: 'customer changed mind',
      });
      expect(r.body.status).toBe('voided');

      r = await api('post', `/sales/${sale.id}/void`, { reason: 'again' });
      expect(r.status).toBe(409);

      expect(await stockOf('COF')).toBe(10);
    });

    it('lists sales with pagination', async () => {
      const r = await api('get', '/sales?limit=10');
      expect(r.body.meta.total).toBe(2);
    });

    it('summarises the period', async () => {
      const from = new Date(Date.now() - 86400e3).toISOString();
      const to = new Date(Date.now() + 60e3).toISOString();
      let r = await api(
        'get',
        `/reports/summary?from=${from}&to=${to}&timezone=America/New_York`,
      );
      // Net sales exclude tax (spec §14); the 10% tax is reported separately
      expect(r.body.totals).toMatchObject({
        saleCount: 1,
        netSales: 25,
        netTax: 2.5,
        totalCollectedInclTax: 27.5,
        voidedCount: 1,
      });
      expect(r.body.byPaymentMethod[0].amount).toBe(27.5);

      r = await api(
        'get',
        `/reports/summary?from=${from}&to=${to}&timezone=Not/AZone`,
      );
      expect(r.status).toBe(400);
    });
  });

  describe('users and roles', () => {
    it('adds a cashier who can log in', async () => {
      let r = await api('post', '/users', {
        email: CASHIER_EMAIL,
        firstName: 'Cash',
        lastName: 'Ier',
        password: CASHIER_PASSWORD,
        role: 'cashier',
      });
      expect(r.body.role).toBe('cashier');
      cashierId = r.body.id;
      createdUserIds.add(cashierId);

      r = await api(
        'post',
        '/auth/login',
        { email: CASHIER_EMAIL, password: CASHIER_PASSWORD },
        null,
      );
      expect(r.body.user.role).toBe('cashier');
      cashierToken = r.body.accessToken;
    });

    it('keeps cashiers out of management endpoints', async () => {
      let r = await api(
        'post',
        '/products',
        { sku: 'X', name: { en: 'X' } },
        cashierToken,
      );
      expect(r.status).toBe(403);
      r = await api('get', '/users', undefined, cashierToken);
      expect(r.status).toBe(403);
    });

    it('lets cashiers use the POS catalog', async () => {
      const r = await api(
        'get',
        `/pos/catalog?registerId=${registerId}`,
        undefined,
        cashierToken,
      );
      expect(r.status).toBe(200);
    });

    it('cuts off a suspended cashier', async () => {
      let r = await api('patch', `/users/${cashierId}`, {
        status: 'suspended',
      });
      expect(r.body.status).toBe('suspended');
      r = await api('get', '/pos/context', undefined, cashierToken);
      // Suspension revokes the member's sessions in the store: the token is dead (401)
      expect(r.status).toBe(401);
    });

    it('does not let the owner change their own role', async () => {
      const members = await api('get', '/users');
      const me = (members.body as { id: string; role: string }[]).find(
        (m) => m.role === 'owner',
      )!;
      const r = await api('patch', `/users/${me.id}`, { role: 'cashier' });
      expect(r.status).toBe(403);
    });
  });
});
