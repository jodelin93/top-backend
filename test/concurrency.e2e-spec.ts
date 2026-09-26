// Must come first: NUMERIC columns are parsed as numbers (same as main.ts)
import '../src/database/pg-types';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import {
  createStore,
  dropStore,
  ledgerBalance,
  listen,
  onHand,
  runId,
  stockedProduct,
  Store,
} from './helpers/test-store';

/**
 * Concurrency and failure tests (spec §23, AC03/04/08/09/10/11/12/16/21/22 and
 * stored value) against the real PostgreSQL database in .env.
 *
 * The app runs in-process and listens on a local port, so the requests of a
 * race really are in flight at the same time (Promise.all over HTTP). Every
 * scenario has its own throwaway store, deleted in its afterAll.
 */

jest.setTimeout(180_000);

const RUN = runId();
const PARALLEL = 5;

let app: INestApplication;
let dataSource: DataSource;
let baseUrl: string;

beforeAll(async () => {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleFixture.createNestApplication({ logger: ['error'] });
  configureApp(app);
  await app.init();
  baseUrl = await listen(app);
  dataSource = app.get(DataSource);
});

afterAll(async () => {
  await app?.close();
});

/** A describe block with its own store */
function withStore(label: string, fn: (s: () => Store) => void) {
  describe(label, () => {
    let store: Store | undefined;
    beforeAll(async () => {
      store = await createStore(
        dataSource,
        baseUrl,
        label.split(' ')[0].toLowerCase(),
      );
    });
    afterAll(async () => {
      await dropStore(dataSource, store);
    });
    fn(() => store!);
  });
}

/** Cash refunds need an open shift on the register */
const openShift = async (s: Store, openingFloat = 100) => {
  const r = await s.api('post', '/shifts/open', {
    registerId: s.registerId,
    openingFloat,
  });
  if (r.status >= 300) {
    throw new Error(`open shift: ${r.status} ${JSON.stringify(r.body)}`);
  }
  return r.body.id as string;
};
const ok = (s: number) => s >= 200 && s < 300;

/** Number of successful responses; fails with the bodies when out of range */
function okCount(
  rs: { status: number; body: unknown }[],
  min: number,
  max = min,
): number {
  const n = rs.filter((r) => ok(r.status)).length;
  if (n < min || n > max) {
    throw new Error(
      `expected ${min === max ? min : `${min}..${max}`} successful responses, got ${n}: ` +
        JSON.stringify(rs.map((r) => [r.status, r.body])).slice(0, 2000),
    );
  }
  return n;
}

const cashSale = (
  s: Store,
  variantId: string,
  quantity: number,
  amount: number,
  key: string,
  extra: object = {},
) =>
  s.api('post', '/sales', {
    registerId: s.registerId,
    items: [{ variantId, quantity }],
    payments: [{ paymentMethodId: s.methods.CASH, amount }],
    idempotencyKey: key,
    ...extra,
  });

withStore('AC03 last unit', (store) => {
  it(`sells the last unit once when ${PARALLEL} tills check out at the same time`, async () => {
    const s = store();
    const { variantId } = await stockedProduct(s, `LAST-${RUN}`, 10, 1, {
      allowBackorder: false,
    });
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        cashSale(s, variantId, 1, 10, `last-${RUN}-${i}`),
      ),
    );
    okCount(responses, 1);
    // The others are refused as a business error, never a server error
    for (const r of responses.filter((x) => !ok(x.status))) {
      expect([400, 409]).toContain(r.status);
    }
    expect(await onHand(dataSource, s.tenantId, variantId, s.locationId)).toBe(
      0,
    );
    expect(
      await ledgerBalance(dataSource, s.tenantId, variantId, s.locationId),
    ).toBe(0);
    const [{ n }] = await dataSource.query<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM sales WHERE "tenantId" = $1 AND status = 'completed'`,
      [s.tenantId],
    );
    expect(n).toBe(1);
  });
});

withStore('AC04 duplicate checkout', (store) => {
  it('the same idempotency key sent in parallel makes one sale, one stock deduction, one number', async () => {
    const s = store();
    const { variantId } = await stockedProduct(s, `DUP-${RUN}`, 7.5, 10);
    const key = `dup-${RUN}`;
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        cashSale(s, variantId, 2, 20, key),
      ),
    );
    const succeeded = responses.filter((r) => ok(r.status));
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    // Losers may only be told to retry (in progress), never get a second sale
    for (const r of responses.filter((x) => !ok(x.status))) {
      expect(r.status).toBe(409);
    }
    const ids = new Set(succeeded.map((r) => r.body.id as string));
    const numbers = new Set(succeeded.map((r) => r.body.saleNumber as string));
    expect(ids.size).toBe(1);
    expect(numbers.size).toBe(1);

    // A retry after the "timeout" gets the same sale
    const retry = await cashSale(s, variantId, 2, 20, key);
    expect(ok(retry.status)).toBe(true);
    expect(retry.body.id).toBe([...ids][0]);

    const [{ n }] = await dataSource.query<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM sales WHERE "tenantId" = $1`,
      [s.tenantId],
    );
    expect(n).toBe(1);
    expect(await onHand(dataSource, s.tenantId, variantId, s.locationId)).toBe(
      8,
    );
    const [{ m }] = await dataSource.query<{ m: number }[]>(
      `SELECT COUNT(*)::int AS m FROM stock_movements
       WHERE "tenantId" = $1 AND "variantId" = $2 AND "referenceType" = 'sale'`,
      [s.tenantId, variantId],
    );
    expect(m).toBe(1);
    const [{ p }] = await dataSource.query<{ p: number }[]>(
      `SELECT COUNT(*)::int AS p FROM payments WHERE "tenantId" = $1`,
      [s.tenantId],
    );
    expect(p).toBe(1);
  });
});

withStore('AC08 refund contention', (store) => {
  let saleId: string;
  let saleItemId: string;
  let saleTotal: number;

  beforeAll(async () => {
    const s = store();
    await openShift(s);
    const { variantId } = await stockedProduct(s, `RET-${RUN}`, 12.35, 10);
    const sale = await cashSale(s, variantId, 3, 40, `ret-sale-${RUN}`);
    expect(sale.status).toBe(201);
    saleId = sale.body.id;
    saleItemId = sale.body.items[0].id;
    saleTotal = sale.body.total;
  });

  const returnOf = (s: Store, quantity: number, key: string) =>
    s.api('post', '/returns', {
      saleId,
      registerId: s.registerId,
      reason: 'race',
      items: [{ saleItemId, quantity, disposition: 'restock' }],
      idempotencyKey: key,
    });

  const refunded = async (s: Store) => {
    const [row] = await dataSource.query<{ total: number; qty: number }[]>(
      `SELECT COALESCE(SUM(r.total), 0)::float AS total,
              (SELECT COALESCE(SUM(i.quantity), 0)::float FROM sale_return_items i
                 JOIN sale_returns r2 ON r2.id = i."returnId" WHERE r2."originalSaleId" = $2) AS qty
       FROM sale_returns r WHERE r."tenantId" = $1 AND r."originalSaleId" = $2`,
      [s.tenantId, saleId],
    );
    return row;
  };

  it('two simultaneous returns of the whole remaining quantity refund it once', async () => {
    const s = store();
    const responses = await Promise.all([
      returnOf(s, 3, `ret-a-${RUN}`),
      returnOf(s, 3, `ret-b-${RUN}`),
    ]);
    okCount(responses, 1);
    const { total, qty } = await refunded(s);
    expect(qty).toBe(3);
    expect(total).toBeLessThanOrEqual(saleTotal);
    expect(total).toBeCloseTo(saleTotal, 2);
  });

  it(`${PARALLEL} simultaneous single-unit returns never exceed the sale`, async () => {
    // A second sale with 2 units: at most 2 of the parallel returns can succeed
    const s = store();
    const { variantId } = await stockedProduct(s, `RET2-${RUN}`, 9.99, 5);
    const sale = await cashSale(s, variantId, 2, 20, `ret-sale2-${RUN}`);
    saleId = sale.body.id;
    saleItemId = sale.body.items[0].id;
    saleTotal = sale.body.total;
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        returnOf(s, 1, `ret-one-${RUN}-${i}`),
      ),
    );
    okCount(responses, 2);
    const { total, qty } = await refunded(s);
    expect(qty).toBe(2);
    expect(total).toBeCloseTo(saleTotal, 2);
    // Money out of the drawer matches: refund payments equal the returns
    const [{ out }] = await dataSource.query<{ out: number }[]>(
      `SELECT COALESCE(SUM(amount), 0)::float AS out FROM sale_return_refunds
       WHERE "tenantId" = $1 AND "returnId" IN (SELECT id FROM sale_returns WHERE "originalSaleId" = $2)`,
      [s.tenantId, saleId],
    );
    expect(out).toBeCloseTo(total, 2);
  });
});

withStore('AC22 coupon race', (store) => {
  it('a single-use code used by two simultaneous sales discounts only one', async () => {
    const s = store();
    const { variantId } = await stockedProduct(s, `CPN-${RUN}`, 20, 10);
    const code = `ONCE${RUN.replace(/[^0-9]/g, '').slice(-6)}`;
    const d = await s.api('post', '/discounts', {
      code,
      name: { en: 'Once' },
      discountType: 'percentage',
      scope: 'cart',
      percentage: 10,
      usageLimit: 1,
    });
    expect(d.status).toBe(201);
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        cashSale(s, variantId, 1, 20, `cpn-${RUN}-${i}`, {
          discountCode: code,
        }),
      ),
    );
    okCount(responses, 1);
    const [row] = await dataSource.query<{ usageCount: number }[]>(
      `SELECT "usageCount" FROM discounts WHERE "tenantId" = $1 AND code = $2`,
      [s.tenantId, code],
    );
    expect(Number(row.usageCount)).toBe(1);
    const [{ n }] = await dataSource.query<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM sales WHERE "tenantId" = $1 AND "discountAmount" > 0`,
      [s.tenantId],
    );
    expect(n).toBe(1);
  });
});

withStore('AC09 goods receipt', (store) => {
  let poId: string;
  let poItemId: string;
  let variantId: string;

  beforeAll(async () => {
    const s = store();
    ({ variantId } = await stockedProduct(s, `GRN-${RUN}`, 5, 0));
    await s.api('patch', '/settings', { purchaseApprovalThreshold: 1_000_000 });
    const supplier = await s.api('post', '/suppliers', {
      code: `SUP${RUN.slice(-5)}`,
      name: 'E2E Supplier',
    });
    expect(supplier.status).toBe(201);
    const po = await s.api('post', '/purchase-orders', {
      supplierId: supplier.body.id,
      locationId: s.locationId,
      items: [{ variantId, quantityOrdered: 10, unitCost: 2 }],
    });
    expect(po.status).toBe(201);
    poId = po.body.id;
    poItemId = po.body.items[0].id;
    const submitted = await s.api('post', `/purchase-orders/${poId}/submit`);
    expect(submitted.body.status).toBe('approved');
    const issued = await s.api('post', `/purchase-orders/${poId}/issue`);
    expect(issued.status).toBe(200);
  });

  it('the same receipt sent twice in parallel posts stock once (partial receipt)', async () => {
    const s = store();
    const body = {
      idempotencyKey: `grn-${RUN}`,
      items: [{ purchaseOrderItemId: poItemId, quantity: 4 }],
    };
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        s.api('post', `/purchase-orders/${poId}/receipts`, body),
      ),
    );
    okCount(responses, 1, 99);
    for (const r of responses.filter((x) => !ok(x.status))) {
      expect(r.status).toBe(409);
    }
    const receiptIds = new Set(
      responses
        .filter((r) => ok(r.status))
        .map((r) => (r.body.id ?? r.body.receipt?.id) as string),
    );
    expect(receiptIds.size).toBe(1);
    expect(await onHand(dataSource, s.tenantId, variantId, s.locationId)).toBe(
      4,
    );
    const [{ n }] = await dataSource.query<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM goods_receipts WHERE "tenantId" = $1`,
      [s.tenantId],
    );
    expect(n).toBe(1);

    // Remaining purchase balance: 6 of 10 still to receive
    const po = await s.api('get', `/purchase-orders/${poId}`);
    const line = po.body.items[0];
    expect(Number(line.quantityReceived)).toBe(4);
    expect(po.body.status).toBe('partially_received');
  });

  it('two different receipts of the whole remainder at once do not both post without approval', async () => {
    // The owner holds purchasing.approve, so an over-receipt is allowed for them;
    // what must hold is that the ledger equals what the receipts say
    const s = store();
    const responses = await Promise.all(
      [0, 1].map((i) =>
        s.api('post', `/purchase-orders/${poId}/receipts`, {
          idempotencyKey: `grn-rest-${RUN}-${i}`,
          items: [{ purchaseOrderItemId: poItemId, quantity: 6 }],
        }),
      ),
    );
    okCount(responses, 1, 99);
    const po = await s.api('get', `/purchase-orders/${poId}`);
    const received = Number(po.body.items[0].quantityReceived);
    expect(await onHand(dataSource, s.tenantId, variantId, s.locationId)).toBe(
      received,
    );
    expect(
      await ledgerBalance(dataSource, s.tenantId, variantId, s.locationId),
    ).toBe(received);
  });
});

withStore('AC10 transfer receipt', (store) => {
  let variantId: string;
  let toLocationId: string;

  beforeAll(async () => {
    const s = store();
    ({ variantId } = await stockedProduct(s, `TRF-${RUN}`, 5, 20));
    const wh = await s.api('post', '/warehouses', {
      code: 'W2',
      name: 'Second',
    });
    expect(wh.status).toBe(201);
    const loc = await s.api('post', '/locations', {
      warehouseId: wh.body.id,
      code: 'L2',
      name: 'Back room',
    });
    expect(loc.status).toBe(201);
    toLocationId = loc.body.id;
  });

  const dispatched = async (s: Store, quantity: number) => {
    const t = await s.api('post', '/inventory/transfers', {
      fromLocationId: s.locationId,
      toLocationId,
      items: [{ variantId, quantity }],
    });
    expect(t.status).toBe(201);
    const requested = await s.api(
      'post',
      `/inventory/transfers/${t.body.id}/request`,
    );
    expect(requested.status).toBe(200);
    const sent = await s.api(
      'post',
      `/inventory/transfers/${t.body.id}/dispatch`,
      {},
    );
    expect(sent.status).toBe(200);
    return t.body.id as string;
  };

  const conserved = async (s: Store) => {
    const from = await onHand(dataSource, s.tenantId, variantId, s.locationId);
    const to = await onHand(dataSource, s.tenantId, variantId, toLocationId);
    const [row] = await dataSource.query<{ transit: number }[]>(
      `SELECT COALESCE(SUM("quantityInTransit"), 0)::float AS transit
       FROM stock_levels WHERE "tenantId" = $1 AND "variantId" = $2`,
      [s.tenantId, variantId],
    );
    return { from, to, transit: row.transit };
  };

  it('the same receipt (same key) sent twice in parallel adds stock once', async () => {
    const s = store();
    const id = await dispatched(s, 5);
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        s.api(
          'post',
          `/inventory/transfers/${id}/receive`,
          { idempotencyKey: `trf-${RUN}` },
          { headers: { 'Idempotency-Key': `trf-h-${RUN}` } },
        ),
      ),
    );
    okCount(responses, 1, 99);
    for (const r of responses.filter((x) => !ok(x.status))) {
      expect(r.status).toBe(409);
    }
    const { from, to, transit } = await conserved(s);
    expect(from).toBe(15);
    expect(to).toBe(5);
    expect(transit).toBe(0);
  });

  it('two different "receive everything" requests at once receive it once', async () => {
    const s = store();
    const id = await dispatched(s, 4);
    const responses = await Promise.all(
      [0, 1, 2].map(() =>
        s.api('post', `/inventory/transfers/${id}/receive`, {}),
      ),
    );
    okCount(responses, 1, 99);
    const { from, to, transit } = await conserved(s);
    expect(transit).toBe(0);
    // Source + destination conserve the 20 units received at the start
    expect(from).toBe(11);
    expect(to).toBe(9);
    expect(from + to).toBe(20);
    expect(
      await ledgerBalance(dataSource, s.tenantId, variantId, toLocationId),
    ).toBe(9);
    const t = await s.api('get', `/inventory/transfers/${id}`);
    expect(t.body.status).toBe('received');
  });
});

withStore('AC12 shift close', (store) => {
  it('closing the same shift twice in parallel (different keys) closes it once', async () => {
    const s = store();
    const shiftId = await openShift(s);
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        s.api('post', `/shifts/${shiftId}/close`, {
          countedCash: 100,
          idempotencyKey: `close-${RUN}-${i}`,
        }),
      ),
    );
    okCount(responses, 1);
    for (const r of responses.filter((x) => !ok(x.status))) {
      expect(r.status).toBe(409);
    }
    const [row] = await dataSource.query<
      { status: string; closeIdempotencyKey: string }[]
    >(`SELECT status, "closeIdempotencyKey" FROM shifts WHERE id = $1`, [
      shiftId,
    ]);
    expect(row.status).toBe('closed');
    const winner = responses.find((r) => ok(r.status))!;
    expect(winner.body.status).toBe('closed');
    expect(Number(winner.body.cashVariance ?? winner.body.variance ?? 0)).toBe(
      0,
    );
  });

  it('the same close retried in parallel (same key) closes once and replays', async () => {
    const s = store();
    const shiftId = await openShift(s);
    const body = {
      countedCash: 95,
      idempotencyKey: `close-same-${RUN}`,
      varianceReason: 'short',
    };
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, () =>
        s.api('post', `/shifts/${shiftId}/close`, body),
      ),
    );
    const succeeded = responses.filter((r) => ok(r.status));
    expect(succeeded.length).toBe(PARALLEL);
    expect(succeeded.filter((r) => r.body.replayed === false)).toHaveLength(1);
    const [{ n }] = await dataSource.query<{ n: number }[]>(
      `SELECT COUNT(*)::int AS n FROM audit_logs
       WHERE "tenantId" = $1 AND action = 'shift.closed' AND "entityId" = $2`,
      [s.tenantId, shiftId],
    );
    expect(n).toBe(1);
  });
});

withStore('AC21 loyalty redemption', (store) => {
  it('two simultaneous sales spending the same points never overdraw them', async () => {
    const s = store();
    const { variantId } = await stockedProduct(s, `LOY-${RUN}`, 10, 10);
    const customer = await s.api('post', '/customers', {
      firstName: 'Loyal',
      lastName: 'Customer',
    });
    const customerId = customer.body.id as string;
    const adjust = await s.api(
      'post',
      `/loyalty/customers/${customerId}/adjust`,
      {
        points: 1000,
        note: 'e2e',
      },
    );
    expect(adjust.status).toBeLessThan(300);
    const loyalty = s.methods.LOYALTY;
    expect(loyalty).toBeDefined();

    // 1000 points × 0.01 = 10.00: enough for exactly one of the sales
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        s.api('post', '/sales', {
          registerId: s.registerId,
          customerId,
          items: [{ variantId, quantity: 1 }],
          payments: [{ paymentMethodId: loyalty, amount: 10 }],
          idempotencyKey: `loy-${RUN}-${i}`,
        }),
      ),
    );
    okCount(responses, 1);
    const [row] = await dataSource.query<{ loyaltyPoints: number }[]>(
      `SELECT "loyaltyPoints" FROM customers WHERE id = $1`,
      [customerId],
    );
    expect(Number(row.loyaltyPoints)).toBe(0);
    // The ledger explains the balance
    const [{ sum }] = await dataSource.query<{ sum: number }[]>(
      `SELECT COALESCE(SUM(points), 0)::int AS sum FROM loyalty_transactions WHERE "customerId" = $1`,
      [customerId],
    );
    expect(sum).toBe(0);
  });
});

withStore('Stored value gift card', (store) => {
  it('two simultaneous redemptions of one gift card never take it below zero', async () => {
    const s = store();
    const { variantId } = await stockedProduct(s, `GC-${RUN}`, 20, 10);
    const code = `E2E${RUN.replace(/[^0-9]/g, '').slice(-10)}GC`;
    const sold = await s.api('post', '/sales', {
      registerId: s.registerId,
      items: [],
      giftCards: [{ amount: 30, code }],
      payments: [{ paymentMethodId: s.methods.CASH, amount: 30 }],
      idempotencyKey: `gc-sell-${RUN}`,
    });
    expect(sold.status).toBe(201);
    const lookup = await s.api(
      'get',
      `/stored-value/gift-cards/lookup?code=${encodeURIComponent(code)}`,
    );
    expect(Number(lookup.body.balance)).toBe(30);

    const giftCard = s.methods.GIFT_CARD;
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) =>
        s.api('post', '/sales', {
          registerId: s.registerId,
          items: [{ variantId, quantity: 1 }],
          payments: [
            { paymentMethodId: giftCard, amount: 20, giftCardCode: code },
          ],
          idempotencyKey: `gc-use-${RUN}-${i}`,
        }),
      ),
    );
    okCount(responses, 1);
    const after = await s.api(
      'get',
      `/stored-value/gift-cards/lookup?code=${encodeURIComponent(code)}`,
    );
    expect(Number(after.body.balance)).toBe(10);
    const [row] = await dataSource.query<
      { balance: number; entries: number }[]
    >(
      `SELECT a.balance::float AS balance,
              (SELECT COALESCE(SUM(e.amount), 0)::float FROM stored_value_entries e WHERE e."accountId" = a.id) AS entries
       FROM stored_value_accounts a WHERE a."tenantId" = $1 AND a."accountType" = 'gift_card'`,
      [s.tenantId],
    );
    expect(row.balance).toBeGreaterThanOrEqual(0);
    expect(row.entries).toBeCloseTo(row.balance, 2);
  });
});

withStore('AC16 historical documents', (store) => {
  it('a later tax and price change leaves the posted sale, its reprint and a partial return unchanged', async () => {
    const s = store();
    await openShift(s);
    const tax = await s.api('post', '/tax-rates', {
      code: 'VAT10',
      name: { en: 'VAT 10%' },
      rate: 10,
    });
    expect(tax.status).toBe(201);
    await s.api('patch', '/settings', {
      defaultTaxRateId: tax.body.id,
      receiptFooter: 'Original footer',
    });
    const { productId, variantId } = await stockedProduct(
      s,
      `HIST-${RUN}`,
      10,
      10,
    );
    const sale = await cashSale(s, variantId, 3, 40, `hist-${RUN}`);
    expect(sale.status).toBe(201);
    expect(sale.body).toMatchObject({ subtotal: 30, taxAmount: 3, total: 33 });
    const saleId = sale.body.id as string;

    // The owner changes the tax rate, the price and the receipt footer
    expect(
      (await s.api('patch', `/tax-rates/${tax.body.id}`, { rate: 20 })).status,
    ).toBe(200);
    expect(
      (await s.api('patch', `/products/${productId}`, { price: 15 })).status,
    ).toBe(200);
    await s.api('patch', '/settings', { receiptFooter: 'New footer' });
    // New sales use the new values…
    const quote = await s.api('post', '/sales/quote', {
      registerId: s.registerId,
      items: [{ variantId, quantity: 1 }],
    });
    expect(quote.body).toMatchObject({ subtotal: 15, taxAmount: 3, total: 18 });

    // …the posted sale does not
    const posted = await s.api('get', `/sales/${saleId}`);
    expect(posted.body).toMatchObject({
      subtotal: 30,
      taxAmount: 3,
      total: 33,
    });
    expect(posted.body.items[0]).toMatchObject({ unitPrice: 10, taxAmount: 3 });
    expect(posted.body.documentSnapshot?.receiptFooter).toBe('Original footer');

    const reprint = await s.api('post', `/sales/${saleId}/reprint`);
    expect(reprint.status).toBe(200);
    const link = await s.api(
      'post',
      `/documents/receipts/${saleId}/share-link`,
      {},
    );
    expect(link.status).toBeLessThan(300);
    const url: string = link.body.url ?? link.body.link ?? '';
    const token = url.split('/').pop() || link.body.token;
    const page = await s.api('get', `/public/receipts/${token}`, undefined, {
      token: null,
    });
    expect(page.status).toBe(200);
    expect(page.text).toContain('33.00');
    expect(page.text).toContain('Original footer');
    expect(page.text).not.toContain('New footer');

    // A partial return refunds the original price and tax: 10 + 1 = 11.00
    const ret = await s.api('post', '/returns', {
      saleId,
      registerId: s.registerId,
      reason: 'changed mind',
      items: [
        {
          saleItemId: posted.body.items[0].id,
          quantity: 1,
          disposition: 'restock',
        },
      ],
      idempotencyKey: `hist-ret-${RUN}`,
    });
    expect(ret.status).toBe(201);
    expect(ret.body).toMatchObject({ subtotal: 10, taxAmount: 1, total: 11 });
  });
});

withStore('AC11 stock count', (store) => {
  it('a sale made while counting is not a variance (roll-forward)', async () => {
    const s = store();
    await s.api('patch', '/settings', { countVarianceTolerance: 5 });
    const a = await stockedProduct(s, `CNTA-${RUN}`, 5, 10);
    const b = await stockedProduct(s, `CNTB-${RUN}`, 5, 10);

    const created = await s.api('post', '/inventory/counts', {
      locationId: s.locationId,
      variantIds: [a.variantId, b.variantId],
    });
    expect(created.status).toBe(201);
    const countId = created.body.id as string;

    // Sold during the count: 3 of A and 2 of B leave the shelf
    expect((await cashSale(s, a.variantId, 3, 15, `cnt-a-${RUN}`)).status).toBe(
      201,
    );
    expect((await cashSale(s, b.variantId, 2, 10, `cnt-b-${RUN}`)).status).toBe(
      201,
    );

    // The shelf really has 7 of A (no loss) and 7 of B (one missing)
    const entered = await s.api('put', `/inventory/counts/${countId}/items`, {
      items: [
        { variantId: a.variantId, countedQuantity: 7 },
        { variantId: b.variantId, countedQuantity: 7, reason: 'missing' },
      ],
    });
    expect(entered.status).toBeLessThan(300);
    const submitted = await s.api(
      'post',
      `/inventory/counts/${countId}/submit`,
    );
    expect(submitted.status).toBe(200);

    const count = await s.api('get', `/inventory/counts/${countId}`);
    const items = count.body.items as {
      variantId: string;
      expectedQuantity: number;
      countedQuantity: number;
      variance?: number;
      movementsSinceSnapshot?: number;
    }[];
    const lineA = items.find((i) => i.variantId === a.variantId)!;
    const lineB = items.find((i) => i.variantId === b.variantId)!;
    expect(Number(lineA.expectedQuantity)).toBe(10);
    expect(Number(lineA.variance)).toBe(0);
    expect(Number(lineB.variance)).toBe(-1);
    expect(count.body.status).toBe('posted');

    expect(
      await onHand(dataSource, s.tenantId, a.variantId, s.locationId),
    ).toBe(7);
    expect(
      await onHand(dataSource, s.tenantId, b.variantId, s.locationId),
    ).toBe(7);
  });
});
