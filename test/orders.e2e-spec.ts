// Must come first: NUMERIC columns are parsed as numbers (same as main.ts)
import '../src/database/pg-types';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import {
  addMember,
  createStore,
  dropStore,
  listen,
  runId,
  stockedProduct,
  Store,
} from './helpers/test-store';

/**
 * Orders with a deposit, end to end against the real database in .env: the
 * deposit goes into the session that took it, the pickup sale is paid by the
 * deposits plus the balance, a void gives the order back, and a cancellation
 * refunds or keeps the deposits.
 */

jest.setTimeout(180_000);

const RUN = runId();

let app: INestApplication;
let dataSource: DataSource;
let s: Store;
let serviceId: string;
let stockedId: string;
let customerId: string;
let shiftId: string;

beforeAll(async () => {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication({ logger: ['error'] });
  configureApp(app);
  await app.init();
  const baseUrl = await listen(app);
  dataSource = app.get(DataSource);
  s = await createStore(dataSource, baseUrl, 'orders');

  serviceId = (
    await stockedProduct(s, `SRV-${RUN}`, 10_000, 0, { isStockTracked: false })
  ).variantId;
  stockedId = (await stockedProduct(s, `STK-${RUN}`, 50, 5)).variantId;
  const customer = await s.api('post', '/customers', {
    firstName: 'Order',
    lastName: 'Customer',
    phone: '+50937000000',
  });
  expect(customer.status).toBe(201);
  customerId = customer.body.id;
  const shift = await s.api('post', '/shifts/open', {
    registerId: s.registerId,
    openingFloat: 100,
  });
  expect(shift.status).toBeLessThan(300);
  shiftId = shift.body.id;
});

afterAll(async () => {
  await dropStore(dataSource, s);
  await app?.close();
});

const takeOrder = (extra: object = {}) =>
  s.api('post', '/orders', {
    registerId: s.registerId,
    customerId,
    items: [{ variantId: serviceId, quantity: 1, note: 'Banner 2 x 1 m' }],
    ...extra,
  });

const paidIn = async (sourceType: string) => {
  const rows = await dataSource.query<{ amount: number; type: string }[]>(
    `SELECT amount, type::text AS type FROM cash_movements
      WHERE "tenantId" = $1 AND "shiftId" = $2 AND "sourceType" = $3`,
    [s.tenantId, shiftId, sourceType],
  );
  return rows;
};

describe('orders with a deposit', () => {
  let orderId: string;
  let saleId: string;

  it('refuses items tracked in stock and a deposit above the total', async () => {
    const stocked = await s.api('post', '/orders', {
      registerId: s.registerId,
      customerId,
      items: [{ variantId: stockedId, quantity: 1 }],
    });
    expect(stocked.status).toBe(400);
    expect(stocked.body.message).toMatch(/tracked in stock/);

    const tooMuch = await takeOrder({
      deposit: { paymentMethodId: s.methods.CASH, amount: 10_001 },
    });
    expect(tooMuch.status).toBe(400);
  });

  it('takes an order with a cash deposit into the open session', async () => {
    const r = await takeOrder({
      readyBy: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      notes: 'Call when ready',
      deposit: { paymentMethodId: s.methods.CASH, amount: 4_000 },
      idempotencyKey: `order-${RUN}`,
    });
    expect(r.status).toBe(201);
    orderId = r.body.id;
    expect(r.body.orderNumber).toMatch(/-CMD-\d{6}$/);
    expect(r.body.status).toBe('open');
    expect(r.body.total).toBe(10_000);
    expect(r.body.paidAmount).toBe(4_000);
    expect(r.body.balanceDue).toBe(6_000);
    expect(r.body.items[0].note).toBe('Banner 2 x 1 m');
    expect(r.body.payments).toHaveLength(1);
    expect(r.body.payments[0].shiftId).toBe(shiftId);

    // Same key: the same order, no second deposit
    const again = await takeOrder({
      deposit: { paymentMethodId: s.methods.CASH, amount: 4_000 },
      idempotencyKey: `order-${RUN}`,
    });
    expect(again.body.id).toBe(orderId);
    expect(await paidIn('order_deposit')).toEqual([
      { amount: 4_000, type: 'paid_in' },
    ]);
  });

  it('takes another deposit, never more than the balance', async () => {
    const over = await s.api('post', `/orders/${orderId}/deposits`, {
      registerId: s.registerId,
      paymentMethodId: s.methods.CARD,
      amount: 6_001,
      reference: 'X1',
    });
    expect(over.status).toBe(400);
    const r = await s.api('post', `/orders/${orderId}/deposits`, {
      registerId: s.registerId,
      paymentMethodId: s.methods.CARD,
      amount: 1_000,
      reference: 'AUTH-1',
    });
    expect(r.status).toBe(201);
    expect(r.body.paidAmount).toBe(5_000);
    // Card: no drawer movement, but filed under the session
    expect(await paidIn('order_deposit')).toHaveLength(1);
    const shift = await s.api(
      'get',
      `/shifts/current?registerId=${s.registerId}`,
    );
    expect(shift.body.shift.sales.orderDeposits.received).toBe(5_000);
  });

  it('marks it ready and lists it for the till', async () => {
    const r = await s.api('post', `/orders/${orderId}/status`, {
      status: 'ready',
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ready');
    const list = await s.api('get', '/orders?status=active&search=Customer');
    const listed = list.body.data as { id: string }[];
    expect(listed.map((o) => o.id)).toContain(orderId);
  });

  it('is picked up by a sale paid by the deposits plus the balance', async () => {
    const sale = (payments: object[], extra: object = {}) =>
      s.api('post', '/sales', {
        registerId: s.registerId,
        customerId,
        orderId,
        items: [{ variantId: serviceId, quantity: 1, unitPrice: 10_000 }],
        payments,
        ...extra,
      });
    // The till tenders the balance only (10,000 - 5,000); short of it is refused
    expect(
      (await sale([{ paymentMethodId: s.methods.CASH, amount: 4_999 }])).status,
    ).toBe(400);
    // Another customer can't pick it up
    const other = await s.api('post', '/customers', { firstName: 'Other' });
    expect(
      (
        await sale([{ paymentMethodId: s.methods.CASH, amount: 5_000 }], {
          customerId: other.body.id,
        })
      ).status,
    ).toBe(400);

    const r = await sale([{ paymentMethodId: s.methods.CASH, amount: 5_000 }]);
    expect(r.status).toBe(201);
    saleId = r.body.id;
    expect(r.body.status).toBe('completed');
    expect(r.body.total).toBe(10_000);
    expect(r.body.metadata.orderId).toBe(orderId);
    const paid = r.body.payments as {
      amount: number;
      paymentMethod: { code: string };
    }[];
    const methods = paid.map((p) => [p.paymentMethod.code, p.amount]);
    expect(methods).toEqual(
      expect.arrayContaining([
        ['ORDER_DEPOSIT', 5_000],
        ['CASH', 5_000],
      ]),
    );
    const order = await s.api('get', `/orders/${orderId}`);
    expect(order.body.status).toBe('picked_up');
    expect(order.body.saleId).toBe(saleId);

    // Once only
    expect(
      (await sale([{ paymentMethodId: s.methods.CASH, amount: 5_000 }])).status,
    ).toBe(409);
  });

  it('gives the order back (ready, deposits intact) when its sale is voided', async () => {
    const v = await s.api('post', `/sales/${saleId}/void`, {
      reason: 'Wrong customer',
    });
    expect(v.status).toBeLessThan(300);
    const order = await s.api('get', `/orders/${orderId}`);
    expect(order.body.status).toBe('ready');
    expect(order.body.saleId).toBeNull();
    expect(order.body.paidAmount).toBe(5_000);
  });

  it('refuses a deposit tender sent by the till', async () => {
    const depositMethod = await dataSource.query<{ id: string }[]>(
      `SELECT id FROM payment_methods WHERE "tenantId" = $1 AND code = 'ORDER_DEPOSIT'`,
      [s.tenantId],
    );
    const r = await s.api('post', '/sales', {
      registerId: s.registerId,
      customerId,
      items: [{ variantId: serviceId, quantity: 1 }],
      payments: [{ paymentMethodId: depositMethod[0].id, amount: 10_000 }],
    });
    expect(r.status).toBe(400);
  });

  it('cancels with the deposits refunded the way each was paid', async () => {
    const r = await s.api('post', `/orders/${orderId}/cancel`, {
      reason: 'Customer changed their mind',
      deposits: 'refund',
      registerId: s.registerId,
    });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('cancelled');
    expect(r.body.depositOutcome).toBe('refunded');
    expect(r.body.paidAmount).toBe(0);
    // The cash deposit comes out of the session in cash, the card one back by card
    expect(await paidIn('order_refund')).toEqual([
      { amount: 4_000, type: 'refund' },
    ]);
    const refunds = (
      r.body.payments as { type: string; paymentMethodId: string; amount: number }[]
    )
      .filter((p) => p.type === 'refund')
      .map((p) => [p.paymentMethodId, p.amount])
      .sort((a, b) => Number(b[1]) - Number(a[1]));
    expect(refunds).toEqual([
      [s.methods.CASH, 4_000],
      [s.methods.CARD, 1_000],
    ]);
    // Nothing more on a cancelled order
    const more = await s.api('post', `/orders/${orderId}/deposits`, {
      registerId: s.registerId,
      paymentMethodId: s.methods.CASH,
      amount: 10,
    });
    expect(more.status).toBe(409);
  });

  it("needs orders.cancel (or a manager's approval) to cancel; kept deposits stay", async () => {
    const r = await takeOrder({
      deposit: {
        paymentMethodId: s.methods.CARD,
        amount: 2_000,
        reference: 'A2',
      },
    });
    expect(r.status).toBe(201);
    const cashier = await addMember(s, 'cashier');
    const refused = await s.api(
      'post',
      `/orders/${r.body.id}/cancel`,
      { reason: 'No show', deposits: 'keep' },
      { token: cashier.token },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.approvable).toBe(true);

    const kept = await s.api('post', `/orders/${r.body.id}/cancel`, {
      reason: 'No show',
      deposits: 'keep',
    });
    expect(kept.status).toBe(200);
    expect(kept.body.depositOutcome).toBe('kept');
    expect(kept.body.paidAmount).toBe(2_000);
  });

  it('lists the deposits in the order deposits report', async () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const r = await s.api(
      'get',
      `/reports/order-deposits?from=${from}&to=${to}`,
    );
    expect(r.status).toBe(200);
    const rows = r.body.rows as { received: number; refunded: number }[];
    expect(rows.reduce((a, row) => a + Number(row.received), 0)).toBe(7_000);
    expect(rows.reduce((a, row) => a + Number(row.refunded), 0)).toBe(5_000);

    // Money taken, by currency and on the dashboard: deposits when paid, less
    // those given back (7,000 - 5,000); the voided pickup and its deposit tender
    // count for nothing
    const byCurrency = await s.api(
      'get',
      `/reports/payments-by-currency?from=${from}&to=${to}`,
    );
    expect(byCurrency.status).toBe(200);
    const value = (byCurrency.body.rows as { value: number }[]).reduce(
      (a, row) => a + Number(row.value),
      0,
    );
    expect(value).toBe(2_000);
    const summary = await s.api('get', `/reports/summary?from=${from}&to=${to}`);
    expect(summary.status).toBe(200);
    const tenders = summary.body.byPaymentMethod as {
      code?: string;
      name: string;
      amount: number;
    }[];
    expect(tenders.reduce((a, row) => a + Number(row.amount), 0)).toBe(2_000);
    expect(tenders.some((row) => /deposit paid/i.test(row.name))).toBe(false);
  });
});
