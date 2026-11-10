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
  listen,
  runId,
  stockedProduct,
  Store,
} from './helpers/test-store';

/**
 * An exchange for a cheaper item, end to end against the real database in .env:
 * the customer bought a 3,000 item, swaps it for a 2,000 one and gets 1,000 back
 * in cash. The drawer only loses the 1,000; the session report shows the new
 * sale, the return and the net, with the exchange credit marked as not money.
 */

jest.setTimeout(180_000);

const RUN = runId();

let app: INestApplication;
let dataSource: DataSource;
let s: Store;
let dearId: string;
let cheapId: string;
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
  s = await createStore(dataSource, baseUrl, 'exchanges');

  dearId = (await stockedProduct(s, `DEAR-${RUN}`, 3_000, 5)).variantId;
  cheapId = (await stockedProduct(s, `CHEAP-${RUN}`, 2_000, 5)).variantId;
  const shift = await s.api('post', '/shifts/open', {
    registerId: s.registerId,
    openingFloat: 500,
  });
  expect(shift.status).toBeLessThan(300);
  shiftId = shift.body.id;
});

afterAll(async () => {
  await dropStore(dataSource, s);
  await app?.close();
});

describe('exchange for a cheaper item', () => {
  it('gives the difference back in cash and reports it as a return, not money taken', async () => {
    const sale = await s.api('post', '/sales', {
      registerId: s.registerId,
      items: [{ variantId: dearId, quantity: 1 }],
      payments: [{ paymentMethodId: s.methods.CASH, amount: 3_000 }],
      idempotencyKey: `sale-${RUN}`,
    });
    expect(sale.status).toBe(201);

    const exchange = await s.api('post', '/returns/exchanges', {
      saleId: sale.body.id,
      registerId: s.registerId,
      reason: 'Wants the cheaper model',
      items: [
        {
          saleItemId: sale.body.items[0].id,
          quantity: 1,
          disposition: 'restock',
        },
      ],
      newSale: {
        items: [{ variantId: cheapId, quantity: 1 }],
        payments: [],
      },
      idempotencyKey: `exchange-${RUN}`,
    });
    expect(exchange.status).toBe(201);

    const report = await s.api('get', `/shifts/${shiftId}/z-report`);
    expect(report.status).toBe(200);
    const { sales, cash } = report.body;

    // Drawer: float 500 + 3,000 sale − 1,000 given back
    expect(cash.cashSales).toBe(3_000);
    expect(cash.cashRefunds).toBe(1_000);
    expect(cash.expected).toBe(2_500);

    // The new item is a sale, paid with the returned goods' credit
    expect(sales.count).toBe(2);
    expect(sales.total).toBe(5_000);
    expect(sales.byPaymentMethod).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'CASH', amount: 3_000 }),
        expect.objectContaining({ code: 'EXCHANGE_CREDIT', amount: 2_000 }),
      ]),
    );
    // The return: 2,000 kept as credit for the new item, 1,000 in cash
    expect(sales.returns.count).toBe(1);
    expect(sales.returns.total).toBe(3_000);
    expect(sales.returns.byPaymentMethod).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EXCHANGE_CREDIT', amount: 2_000 }),
        expect.objectContaining({ code: 'CASH', amount: 1_000 }),
      ]),
    );
    expect(sales.returns.byPaymentMethod).toHaveLength(2);
  });
});
