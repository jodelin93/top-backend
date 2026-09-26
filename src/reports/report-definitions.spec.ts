import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { AuditService } from '../audit/audit.service';
import { findReport, REPORTS, REVENUE_LINE } from './report-definitions';
import {
  canRunReport,
  ReportRunnerService,
  visibleColumns,
} from './report-runner.service';
import { bindParams, branchFilter, scopeOf } from './report-sql';

const TENANT = '11111111-1111-1111-1111-111111111111';
const BRANCH_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const BRANCH_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const VARIANT = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const RANGE = { from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' };
const EVERYTHING = [
  'reports.view',
  'reports.export',
  'inventory.cost.view',
  'purchasing.manage',
  'purchasing.payables',
  'audit.view',
];
// Reports that can't be split by branch
const STORE_WIDE = ['supplier-aging', 'audit-activity'];

function setup(rows: Record<string, unknown>[] = []) {
  const query = jest.fn((sql: string) =>
    Promise.resolve(
      sql.includes('FROM devices')
        ? [{ pendingSales: 2, failedSales: 0, devicesWithPendingSales: 1 }]
        : rows,
    ),
  );
  const runner = new ReportRunnerService(
    { query } as unknown as DataSource,
    { record: jest.fn() } as unknown as AuditService,
  );
  return { runner, query };
}

const paramsOf = (report: (typeof REPORTS)[number]) => ({
  ...RANGE,
  ...(report.parameters?.some((p) => p.key === 'variantId')
    ? { variantId: VARIANT }
    : {}),
});

describe('report catalog (spec §14)', () => {
  it('leaves gift cards sold (stored value) out of revenue, tax and product reports', () => {
    for (const key of [
      'sales-by-day',
      'sales-by-product',
      'sales-by-category',
      'sales-by-cashier',
      'sales-by-salesperson',
      'tax',
    ]) {
      expect({ key, sql: findReport(key)?.sql }).toEqual({
        key,
        sql: expect.stringContaining(REVENUE_LINE) as string,
      });
    }
  });

  it('keeps exchange credit (an internal tender) out of the tender mix', () => {
    for (const key of ['payments-by-method', 'payments-by-currency']) {
      expect(findReport(key)?.sql).toContain("'EXCHANGE_CREDIT'");
    }
  });

  it('has unique keys', () => {
    const keys = REPORTS.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('filters every branch-aware report on the branch parameter ($5)', () => {
    for (const report of REPORTS) {
      if (report.branchFilter) {
        expect({
          key: report.key,
          usesBranch: /\$5\b/.test(report.sql),
        }).toEqual({ key: report.key, usesBranch: true });
      }
    }
    expect(REPORTS.filter((r) => !r.branchFilter).map((r) => r.key)).toEqual(
      STORE_WIDE,
    );
  });

  it.each(REPORTS.filter((r) => r.branchFilter).map((r) => [r.key]))(
    '%s restricts its query to the scope branches',
    async (key) => {
      const report = findReport(key)!;
      const { runner, query } = setup();
      await runner.run(TENANT, key, paramsOf(report), EVERYTHING, {
        branchIds: [BRANCH_A, BRANCH_B],
      });
      const [sql, values] = query.mock.calls[0] as unknown as [
        string,
        unknown[],
      ];
      // The branch list is bound (renumbered) and used by the query
      expect(values).toContainEqual([BRANCH_A, BRANCH_B]);
      const n = values.findIndex((v) => Array.isArray(v) && v[0] === BRANCH_A);
      expect(sql).toContain(`$${n + 1}::uuid[]`);
    },
  );

  it('binds no branch restriction without a filter or scope', async () => {
    const { runner, query } = setup();
    await runner.run(TENANT, 'sales-by-day', RANGE, EVERYTHING);
    const values = (query.mock.calls[0] as unknown[])[1] as unknown[];
    expect(values).toContain(null);
    expect(values).not.toContainEqual([BRANCH_A]);
  });

  it('narrows to the requested branch, refused outside the scope', async () => {
    const { runner, query } = setup();
    await runner.run(
      TENANT,
      'sales-by-day',
      { ...RANGE, branchId: BRANCH_B },
      EVERYTHING,
      { branchIds: [BRANCH_A, BRANCH_B] },
    );
    expect((query.mock.calls[0] as unknown[])[1]).toContainEqual([BRANCH_B]);
    await expect(
      runner.run(
        TENANT,
        'sales-by-day',
        { ...RANGE, branchId: BRANCH_B },
        EVERYTHING,
        {
          branchIds: [BRANCH_A],
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses store-wide reports to branch-limited users and branch filters', () => {
    const { runner } = setup();
    expect(() =>
      runner.prepare(TENANT, 'supplier-aging', {}, EVERYTHING, {
        branchIds: [BRANCH_A],
      }),
    ).toThrow(ForbiddenException);
    expect(() =>
      runner.prepare(
        TENANT,
        'audit-activity',
        { ...RANGE, branchId: BRANCH_A },
        EVERYTHING,
      ),
    ).toThrow(BadRequestException);
    expect(
      runner.catalog(EVERYTHING, { branchIds: [BRANCH_A] }).map((r) => r.key),
    ).not.toContain('supplier-aging');
  });

  it('returns the generation time and whether till sales are still pending', async () => {
    const { runner } = setup([
      { date: '2026-09-01', currency: 'USD', saleCount: '3' },
    ]);
    const result = await runner.run(TENANT, 'sales-by-day', RANGE, EVERYTHING);
    expect(result.generatedAt).toEqual(expect.any(String));
    expect(result.freshness).toMatchObject({
      pendingSales: 2,
      complete: false,
    });
    expect(result.rows[0].saleCount).toBe(3);
  });
});

describe('bindParams', () => {
  it('binds only the placeholders a query uses, renumbered', () => {
    const { sql, values } = bindParams('SELECT $1, $5::uuid[], $5, $7', [
      't',
      'from',
      'to',
      'tz',
      ['b'],
      'v',
      'l',
    ]);
    expect(sql).toBe('SELECT $1, $2::uuid[], $2, $3');
    expect(values).toEqual(['t', ['b'], 'l']);
  });

  it('refuses a placeholder beyond the bound parameters', () => {
    expect(() => bindParams('SELECT $3', [1, 2])).toThrow();
  });

  it('computes the branch filter from request and scope', () => {
    expect(branchFilter(undefined)).toBeNull();
    expect(branchFilter(BRANCH_A)).toEqual([BRANCH_A]);
    expect(branchFilter(undefined, { branchIds: [] })).toEqual([]);
    expect(() => branchFilter(BRANCH_A, { branchIds: [BRANCH_B] })).toThrow(
      ForbiddenException,
    );
    expect(scopeOf({ id: 'u' })).toBeUndefined();
    expect(scopeOf({ branchIds: [BRANCH_A] })).toEqual({
      branchIds: [BRANCH_A],
    });
  });
});

describe('new reports', () => {
  it('sales by hour is heatmap-ready: weekday × hour in the store time zone', () => {
    const r = findReport('sales-by-hour')!;
    expect(r.columns.map((c) => c.key)).toEqual(
      expect.arrayContaining([
        'weekday',
        'hour',
        'currency',
        'saleCount',
        'netSales',
      ]),
    );
    expect(r.sql).toMatch(/ISODOW FROM s\."saleDate" AT TIME ZONE \$4/);
    expect(r.sql).toMatch(/HOUR FROM s\."saleDate" AT TIME ZONE \$4/);
  });

  it('sales by salesperson groups on sales.salespersonId', () => {
    expect(findReport('sales-by-salesperson')!.sql).toContain(
      's."salespersonId" IS NOT NULL',
    );
  });

  it('stock card needs a variant, takes an optional location and has opening / closing rows', () => {
    const r = findReport('stock-card')!;
    expect(r.parameters).toEqual([
      expect.objectContaining({ key: 'variantId', required: true }),
      expect.objectContaining({ key: 'locationId', required: false }),
    ]);
    expect(r.sql).toContain('$6::uuid');
    expect(r.sql).toContain('$7::uuid');
    expect(r.sql).toContain("'Opening balance'");
    expect(r.sql).toContain("'Closing balance'");
    expect(r.sql).toMatch(/SUM\(qin - qout\) OVER/);
    const { runner } = setup();
    expect(() =>
      runner.prepare(TENANT, 'stock-card', RANGE, EVERYTHING),
    ).toThrow(BadRequestException);
  });

  it('counts & adjustments show variances, reasons and approvers', () => {
    const r = findReport('stock-adjustments')!;
    expect(r.sql).toContain('stock_count_items');
    expect(r.sql).toContain('m."referenceType" = \'adjustment\'');
    expect(r.columns.map((c) => c.key)).toEqual(
      expect.arrayContaining(['variance', 'reason', 'approvedBy']),
    );
  });

  it('transfers show shipped, received, damaged, missing and in transit', () => {
    const r = findReport('transfers')!;
    expect(r.columns.map((c) => c.key)).toEqual(
      expect.arrayContaining([
        'shipped',
        'received',
        'damaged',
        'missing',
        'inTransit',
      ]),
    );
    expect(r.sql).toContain('"quantityWrittenOff"');
  });

  it('purchasing compares supplier invoices with receipts', () => {
    const r = findReport('purchasing')!;
    for (const table of [
      'goods_receipts',
      'supplier_invoices',
      'supplier_allocations',
      'supplier_payments',
    ]) {
      expect(r.sql).toContain(table);
    }
    expect(r.columns.map((c) => c.key)).toContain('invoicedVsReceived');
  });

  it('supplier aging follows the payables buckets', () => {
    const r = findReport('supplier-aging')!;
    expect(r.columns.map((c) => c.key)).toEqual([
      'code',
      'supplier',
      'currency',
      'current',
      'days1to30',
      'days31to60',
      'days61to90',
      'over90',
      'unapplied',
      'balance',
    ]);
    expect(r.sql).toContain("p.status = 'posted'");
    expect(r.sql).toContain("c.status = 'open'");
    expect(r.sql).toContain("i.status <> 'void'");
  });

  it('expenses and loyalty are per currency', () => {
    for (const key of ['expenses', 'loyalty']) {
      expect(findReport(key)!.columns.map((c) => c.key)).toContain('currency');
    }
    expect(findReport('loyalty')!.sql).toContain('loyaltyPointValue');
  });

  it('gates reports and cost columns on permissions', () => {
    const gates: Record<string, string[]> = {
      'supplier-aging': ['purchasing.payables', 'purchasing.manage'],
      'audit-activity': ['audit.view'],
      purchasing: ['purchasing.manage', 'purchasing.payables'],
    };
    for (const [key, permissions] of Object.entries(gates)) {
      const report = findReport(key)!;
      expect(canRunReport(report, ['reports.view'])).toBe(false);
      for (const permission of permissions) {
        expect(canRunReport(report, ['reports.view', permission])).toBe(true);
      }
    }
    const { runner } = setup();
    expect(() =>
      runner.prepare(TENANT, 'audit-activity', RANGE, ['reports.view']),
    ).toThrow(ForbiddenException);
    const catalog = runner.catalog(['reports.view']).map((r) => r.key);
    expect(catalog).not.toContain('audit-activity');
    expect(catalog).toContain('sales-by-hour');
    for (const key of ['stock-adjustments', 'transfers', 'stock-card']) {
      const columns = visibleColumns(findReport(key)!.columns, [
        'reports.view',
      ]);
      expect(columns.some((c) => c.type === 'money')).toBe(false);
    }
  });

  it('never totals money of several currencies', async () => {
    const { runner } = setup([
      { category: 'Food', currency: 'USD', count: 1, amount: 10 },
      { category: 'Food', currency: 'HTG', count: 2, amount: 1300 },
    ]);
    const result = await runner.run(TENANT, 'expenses', RANGE, EVERYTHING);
    expect(result.mixedCurrencies).toBe(true);
    expect(result.totals).toEqual({ count: 3 });
  });
});

describe('payments by currency', () => {
  it('reports amounts in the sale currency, grouped by tendered and sale currency', () => {
    const r = findReport('payments-by-currency')!;
    const value = r.columns.find((c) => c.key === 'value')!;
    expect(value.label).toBe('Value in sale currency');
    expect(r.columns.map((c) => c.key)).toEqual(
      expect.arrayContaining(['tenderedCurrency', 'currency']),
    );
    expect(r.sql).toMatch(/TRIM\(s\."currencyCode"\) AS currency/);
    expect(r.sql).toContain('GROUP BY 1, 2');
    expect(JSON.stringify(r)).not.toContain('store currency');
  });
});
