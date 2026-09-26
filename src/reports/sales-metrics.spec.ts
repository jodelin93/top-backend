import {
  currencyMetrics,
  metricsByCurrency,
  ReturnsAggregate,
  SalesAggregate,
} from './sales-metrics';
import { REPORTS } from './report-definitions';
import { reportTotals, visibleColumns } from './report-runner.service';

// Two sales, prices excl. tax, 10% tax:
//   A: 2 × 50.00, 10.00 discount → net 90.00 + tax 9.00 = 99.00
//   B: 1 × 20.00                 → net 20.00 + tax 2.00 = 22.00
const usdSales: SalesAggregate = {
  currencyCode: 'USD',
  saleCount: 2,
  itemsSold: 3,
  grossSalesExTax: 120,
  netLinesExTax: 110,
  tax: 11,
  totalInclTax: 121,
  costOfGoods: 60,
};
// Sale B fully returned (restocked, cost 8)
const usdReturns: ReturnsAggregate = {
  currencyCode: 'USD',
  returnCount: 1,
  returnsExTax: 20,
  returnTax: 2,
  returnsInclTax: 22,
  restockedCost: 8,
};

describe('sales metrics (spec §14)', () => {
  it('computes gross, discounts and net sales excluding tax', () => {
    const m = currencyMetrics(usdSales, usdReturns, false);
    expect(m.grossSales).toBe(120);
    expect(m.discounts).toBe(10);
    expect(m.returns).toBe(20);
    // 120 − 10 − 20: tax never included
    expect(m.netSales).toBe(90);
  });

  it('nets tax as sale tax minus return tax', () => {
    const m = currencyMetrics(usdSales, usdReturns, false);
    expect(m.tax).toBe(11);
    expect(m.returnTax).toBe(2);
    expect(m.netTax).toBe(9);
  });

  it('averages net sales over completed sales, fully returned ones included', () => {
    // Sale B was fully returned: still one of the 2 orders, its value is gone
    const m = currencyMetrics(usdSales, usdReturns, false);
    expect(m.averageOrderValue).toBe(45);
    expect(
      currencyMetrics({ ...usdSales, saleCount: 0 }, usdReturns, false)
        .averageOrderValue,
    ).toBe(0);
  });

  it('keeps the tax-inclusive money collected as a separate figure', () => {
    const m = currencyMetrics(usdSales, usdReturns, false);
    expect(m.salesInclTax).toBe(121);
    expect(m.refundsInclTax).toBe(22);
    expect(m.totalCollectedInclTax).toBe(99);
  });

  it('works out prices that include tax the same way', () => {
    // 2 × 55.00 incl. 10% tax, 11.00 off → net incl. 99.00, tax 9.00
    const m = currencyMetrics(
      {
        currencyCode: 'USD',
        saleCount: 1,
        itemsSold: 2,
        grossSalesExTax: 100,
        netLinesExTax: 90,
        tax: 9,
        totalInclTax: 99,
        costOfGoods: 0,
      },
      { ...usdReturns, returnCount: 0, returnsExTax: 0, returnTax: 0 },
      false,
    );
    expect(m.discounts).toBe(10);
    expect(m.netSales).toBe(90);
    expect(m.totalCollectedInclTax).toBe(99 - usdReturns.returnsInclTax);
  });

  it('hides cost, profit and margin without cost access', () => {
    const hidden = currencyMetrics(usdSales, usdReturns, false);
    expect(hidden).not.toHaveProperty('costOfGoods');
    expect(hidden).not.toHaveProperty('grossProfit');
    expect(hidden).not.toHaveProperty('margin');

    const shown = currencyMetrics(usdSales, usdReturns, true);
    // Restocked items are no longer a cost of sale
    expect(shown.costOfGoods).toBe(52);
    expect(shown.grossProfit).toBe(38);
    expect(shown.margin).toBeCloseTo(38 / 90);
  });

  it('never adds currencies together; the store currency comes first', () => {
    const htg: SalesAggregate = {
      ...usdSales,
      currencyCode: 'HTG',
      grossSalesExTax: 13000,
      netLinesExTax: 13000,
      saleCount: 1,
    };
    const [store, ...others] = metricsByCurrency(
      'USD',
      [htg, usdSales],
      [usdReturns],
      false,
    );
    expect(store.currencyCode).toBe('USD');
    expect(store.netSales).toBe(90);
    expect(others).toHaveLength(1);
    expect(others[0]).toMatchObject({ currencyCode: 'HTG', netSales: 13000 });
  });

  it('reports zero store-currency totals when only other currencies sold', () => {
    const [store, other] = metricsByCurrency(
      'USD',
      [{ ...usdSales, currencyCode: 'HTG' }],
      [],
      false,
    );
    expect(store).toMatchObject({
      currencyCode: 'USD',
      saleCount: 0,
      netSales: 0,
    });
    expect(other.currencyCode).toBe('HTG');
  });
});

describe('report definitions', () => {
  it('never labels a tax-inclusive figure as net sales', () => {
    const byDay = REPORTS.find((r) => r.key === 'sales-by-day')!;
    const net = byDay.columns.find((c) => c.key === 'netSales');
    expect(net?.label).toBe('Net sales (excl. tax)');
    expect(byDay.columns.find((c) => c.key === 'collected')?.label).toContain(
      'incl. tax',
    );
  });

  it('drops cost columns for users without inventory.cost.view', () => {
    for (const key of ['sales-by-product', 'inventory-valuation']) {
      const report = REPORTS.find((r) => r.key === key)!;
      const keys = visibleColumns(report.columns, ['reports.view']).map(
        (c) => c.key,
      );
      for (const hidden of ['cost', 'profit', 'margin', 'unitCost', 'value'])
        if (report.columns.some((c) => c.key === hidden && c.requires))
          expect(keys).not.toContain(hidden);
      expect(
        visibleColumns(report.columns, ['inventory.cost.view']),
      ).toHaveLength(report.columns.length);
    }
  });

  it('does not total money across currencies', () => {
    const columns = REPORTS.find((r) => r.key === 'sales-by-day')!.columns;
    const single = reportTotals(columns, [
      { currency: 'USD', saleCount: 1, netSales: 10 },
      { currency: 'USD', saleCount: 2, netSales: 5 },
    ]);
    expect(single.mixedCurrencies).toBe(false);
    expect(single.totals).toMatchObject({ saleCount: 3, netSales: 15 });

    const mixed = reportTotals(columns, [
      { currency: 'USD', saleCount: 1, netSales: 10 },
      { currency: 'HTG', saleCount: 2, netSales: 1300 },
    ]);
    expect(mixed.mixedCurrencies).toBe(true);
    expect(mixed.totals).toEqual({ saleCount: 3 });
  });
});
