import type { DataSource } from 'typeorm';
import { ReconciliationReportService } from './reconciliation.service';

const TENANT = '11111111-1111-1111-1111-111111111111';
const BRANCH = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RANGE = { from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' };

function setup() {
  const query = jest.fn((sql: string) =>
    Promise.resolve(
      sql.includes('"refundsPaid"')
        ? [
            {
              currencyCode: 'HTG',
              saleCount: '2',
              salesTotal: 2650,
              linesTotal: 2650,
              paymentsNet: 2650,
              returnsTotal: 0,
              refundsPaid: 0,
            },
            {
              currencyCode: 'USD',
              saleCount: '3',
              salesTotal: 60,
              linesTotal: 60,
              paymentsNet: 55,
              returnsTotal: 10,
              refundsPaid: 10,
            },
          ]
        : [],
    ),
  );
  return {
    service: new ReconciliationReportService({
      query,
    } as unknown as DataSource),
    query,
  };
}

describe('reconciliation totals', () => {
  it('are per currency, never summed across currencies', async () => {
    const { service, query } = setup();
    const result = await service.run(TENANT, RANGE);
    expect(result.totals).toEqual([
      expect.objectContaining({
        currencyCode: 'HTG',
        salesTotal: 2650,
        saleCount: 2,
      }),
      expect.objectContaining({
        currencyCode: 'USD',
        salesTotal: 60,
        paymentsNet: 55,
      }),
    ]);
    // Only counts add up across currencies
    expect(result.saleCount).toBe(5);
    expect(result).not.toHaveProperty('totals.salesTotal');
    const totalsSql = query.mock.calls[0][0];
    expect(totalsSql).toMatch(/TRIM\(s\."currencyCode"\) AS c/);
    expect(totalsSql).toContain('GROUP BY 1');
  });

  it('limits every check to the branch and skips store-wide ones', async () => {
    const { service, query } = setup();
    const all = await service.run(TENANT, RANGE, undefined, FINANCE);
    query.mockClear();
    const branch = await service.run(
      TENANT,
      { ...RANGE, branchId: BRANCH },
      undefined,
      FINANCE,
    );
    expect(branch.checks.length).toBe(all.checks.length - 3);
    expect(branch.checks.map((c) => c.key)).not.toContain('loyalty-ledger');
    expect(branch.checks.map((c) => c.key)).not.toContain(
      'customer-credit-ledger',
    );
    for (const [sql, values] of query.mock.calls as unknown as [
      string,
      unknown[],
    ][]) {
      const n = values.findIndex((v) => Array.isArray(v));
      expect(n).toBeGreaterThanOrEqual(0);
      expect(values[n]).toEqual([BRANCH]);
      expect(sql).toContain(`$${n + 1}::uuid[]`);
    }
  });
});

const FINANCE = ['reports.view', 'customers.finance.view'];

describe('ledger checks', () => {
  it('leave out balance checks for users who may not see balances', async () => {
    const query = jest.fn(() => Promise.resolve([]));
    const service = new ReconciliationReportService({
      query,
    } as unknown as DataSource);
    const result = await service.run(TENANT, RANGE, undefined, [
      'reports.view',
    ]);
    const keys = result.checks.map((c) => c.key);
    expect(keys).not.toContain('customer-credit-ledger');
    expect(keys).not.toContain('stored-value-ledger');
    expect(keys).toContain('loyalty-ledger');
    const sql = (query.mock.calls as unknown as [string][]).map(([q]) => q);
    expect(sql.some((q) => q.includes('customer_credit_entries'))).toBe(false);
    expect(sql.some((q) => q.includes('stored_value_entries'))).toBe(false);
  });

  it('flag customer account and stored value balances that differ from their ledgers', async () => {
    const query = jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('FROM customer_credit_entries')
          ? [
              {
                reference: 'Ana',
                expected: 40,
                actual: 45,
                detail: '3 ledger entries',
              },
            ]
          : sql.includes('FROM stored_value_entries')
            ? [
                {
                  reference: 'gift_card ****1234',
                  expected: 10,
                  actual: 25,
                  detail: '2 entries, USD, active',
                },
              ]
            : [],
      ),
    );
    const service = new ReconciliationReportService({
      query,
    } as unknown as DataSource);
    const result = await service.run(TENANT, RANGE, undefined, FINANCE);
    const byKey = new Map(result.checks.map((c) => [c.key, c]));
    expect(byKey.get('customer-credit-ledger')).toMatchObject({
      passed: false,
      issues: [{ reference: 'Ana', expected: 40, actual: 45 }],
    });
    expect(byKey.get('stored-value-ledger')).toMatchObject({
      passed: false,
      issues: [{ reference: 'gift_card ****1234', expected: 10, actual: 25 }],
    });
    expect(result.passed).toBe(false);
    const creditSql = (query.mock.calls as unknown as [string][])
      .map(([sql]) => sql)
      .find((sql) => sql.includes('customer_credit_entries'));
    expect(creditSql).toContain('"currentBalance"');
  });
});
