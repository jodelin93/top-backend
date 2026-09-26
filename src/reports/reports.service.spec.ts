import type { DataSource } from 'typeorm';
import type { SettingsService } from '../settings/settings.service';
import { REVENUE_LINE, STORED_VALUE_LINE } from './report-definitions';
import { ReportsService } from './reports.service';

describe('ReportsService.summary: gift cards and exchange credit', () => {
  function setup() {
    const sqls: string[] = [];
    const query = jest.fn((sql: string) => {
      sqls.push(sql);
      if (sql.includes(STORED_VALUE_LINE)) {
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
      { query } as unknown as DataSource,
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

  it('leaves exchange credit out of the tender mix', async () => {
    const { service, sqls } = setup();
    await service.summary('t1', {
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T23:59:59Z',
    });
    const tenderSql = sqls.find((sql) => sql.includes('"methodType"'));
    expect(tenderSql).toContain("pm.code <> 'EXCHANGE_CREDIT'");
  });
});
