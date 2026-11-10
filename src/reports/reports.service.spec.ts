import type { DataSource } from 'typeorm';
import type { SettingsService } from '../settings/settings.service';
import {
  RETURN_TAX,
  RETURN_TOTAL,
  RETURNED_STORED_VALUE,
  REVENUE_LINE,
  STORED_VALUE_LINE,
} from './report-definitions';
import { ReportsService } from './reports.service';

describe('ReportsService.summary: gift cards and exchange credit', () => {
  function setup() {
    const sqls: string[] = [];
    const query = jest.fn((sql: string) => {
      sqls.push(sql);
      // Gift cards sold (returns use the same line test, through RETURNED_STORED_VALUE)
      if (sql.includes(STORED_VALUE_LINE) && !sql.includes('sale_returns')) {
        return Promise.resolve([
          { currencyCode: 'USD', amount: '50.00', count: '2' },
        ]);
      }
      if (sql.includes('"voidedCount"')) {
        return Promise.resolve([{ voidedCount: 0 }]);
      }
      if (sql.includes('"lowStockCount"')) {
        return Promise.resolve([{ lowStockCount: 0 }]);
      }
      return Promise.resolve([]);
    });
    const settings = {
      getSettings: jest.fn(() =>
        Promise.resolve({ currencyCode: 'USD', lowStockThreshold: 5 }),
      ),
    };
    const service = new ReportsService(
      {
        query,
        // Report queries run in a transaction with a statement timeout
        transaction: (work: (m: unknown) => Promise<unknown>) =>
          work({
            query: (sql: string, values?: unknown[]) =>
              sql.startsWith('SET LOCAL')
                ? Promise.resolve([])
                : (query as (...args: unknown[]) => Promise<unknown>)(
                    sql,
                    values,
                  ),
          }),
      } as unknown as DataSource,
      settings as unknown as SettingsService,
    );
    return { service, sqls };
  }

  it('shows gift cards sold apart and keeps them out of sales figures', async () => {
    const { service, sqls } = setup();
    const result = await service.summary('t1', {
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T23:59:59Z',
    });
    expect(result.giftCardsSold).toEqual([
      { currencyCode: 'USD', amount: 50, count: 2 },
    ]);
    const salesSql = sqls.find((sql) => sql.includes('"grossSalesExTax"'));
    expect(salesSql).toContain(REVENUE_LINE);
    const topSql = sqls.find((sql) => sql.includes('LIMIT 10'));
    expect(topSql).toContain(REVENUE_LINE);
  });

  it('takes returned gift cards off returns in the totals and the chart alike', async () => {
    const { service, sqls } = setup();
    await service.summary('t1', {
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T23:59:59Z',
    });
    const returnSqls = sqls.filter((sql) =>
      sql.includes('FROM sale_returns r'),
    );
    // Return totals (tiles, daily summary) and returns per day (chart)
    expect(returnSqls).toHaveLength(2);
    for (const sql of returnSqls) {
      expect(sql).toContain(RETURNED_STORED_VALUE);
      expect(sql).toContain(RETURN_TOTAL);
      expect(sql).toContain(RETURN_TAX);
    }
    // The chart sums sale_returns itself: never its raw total / tax
    const chartSql = returnSqls.find((sql) => sql.includes('AS day'));
    expect(chartSql).not.toMatch(/SUM\(r\.(total|"taxAmount")/);
  });

  it('leaves exchange credit out of the tender mix', async () => {
    const { service, sqls } = setup();
    await service.summary('t1', {
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T23:59:59Z',
    });
    const tenderSql = sqls.find((sql) => sql.includes('"methodType"'));
    expect(tenderSql).toContain(
      "pm.code NOT IN ('EXCHANGE_CREDIT', 'ORDER_DEPOSIT')",
    );
  });
});
