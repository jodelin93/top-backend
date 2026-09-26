/**
 * Dashboard sales metrics (spec §14), per currency. Pure math over aggregated
 * rows, so the definitions are unit-tested without a database.
 *
 * - Gross sales: completed line quantity × pre-discount unit price, excluding tax
 * - Discounts: line and cart discounts allocated to the lines, excluding tax
 * - Returns: value of the eligible returns processed in the period, excluding tax
 * - Net sales = gross sales − discounts − returns (never includes tax)
 * - Net tax = tax on sales − tax refunded on returns
 * - Average order value = net sales / completed sale count
 *
 * Sales that were later partly or fully returned still count as completed sales
 * (the order happened); their returns reduce net sales in the period the return
 * was processed. So a fully returned sale adds 1 to the sale count and 0 to net
 * sales once both fall in the same period, lowering the average order value.
 *
 * Amounts in different currencies are never added together: each currency
 * gets its own figures.
 *
 * Gift cards sold (sale lines with metadata.storedValue = true) are stored value,
 * a liability rather than revenue: they are not in any of these figures (the
 * aggregates leave those lines out) and are reported apart ("Gift cards sold").
 * Exchange credit is an internal tender, not a payment: it is left out of the
 * tender mix.
 */

import { roundQty } from '../common/utils/quantity';

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Aggregated sale lines of one currency */
export interface SalesAggregate {
  currencyCode: string;
  saleCount: number;
  // Quantity sold: units, plus decimals of measured items (1.25 kg)
  itemsSold: number;
  // Number of sale lines (each weighing of a measured item is its own line)
  lineCount?: number;
  // Pre-discount line value excluding tax
  grossSalesExTax: number;
  // Line total excluding tax (after discounts)
  netLinesExTax: number;
  tax: number;
  // What customers were charged, tax included
  totalInclTax: number;
  costOfGoods: number;
}

/** Aggregated returns of one currency */
export interface ReturnsAggregate {
  currencyCode: string;
  returnCount: number;
  // Refund value excluding tax
  returnsExTax: number;
  returnTax: number;
  returnsInclTax: number;
  // Cost of items put back on the shelf (no longer a cost of sale)
  restockedCost: number;
}

export interface CurrencyMetrics {
  currencyCode: string;
  saleCount: number;
  // Quantity sold (may have decimals for measured items)
  itemsSold: number;
  // Sale lines: the "number of items" on the receipts
  lineCount: number;
  grossSales: number;
  discounts: number;
  returnCount: number;
  returns: number;
  netSales: number;
  tax: number;
  returnTax: number;
  netTax: number;
  averageOrderValue: number;
  // Clearly tax-inclusive figures: what customers paid and got back
  salesInclTax: number;
  refundsInclTax: number;
  totalCollectedInclTax: number;
  // Only with inventory.cost.view
  costOfGoods?: number;
  grossProfit?: number;
  margin?: number | null;
}

const emptySales = (currencyCode: string): SalesAggregate => ({
  currencyCode,
  saleCount: 0,
  itemsSold: 0,
  lineCount: 0,
  grossSalesExTax: 0,
  netLinesExTax: 0,
  tax: 0,
  totalInclTax: 0,
  costOfGoods: 0,
});

const emptyReturns = (currencyCode: string): ReturnsAggregate => ({
  currencyCode,
  returnCount: 0,
  returnsExTax: 0,
  returnTax: 0,
  returnsInclTax: 0,
  restockedCost: 0,
});

export function currencyMetrics(
  sales: SalesAggregate,
  returns: ReturnsAggregate,
  showCost: boolean,
): CurrencyMetrics {
  const grossSales = round2(sales.grossSalesExTax);
  // Whatever the line value lost between its list price and its net value
  const discounts = round2(sales.grossSalesExTax - sales.netLinesExTax);
  const returnsExTax = round2(returns.returnsExTax);
  const netSales = round2(grossSales - discounts - returnsExTax);
  const metrics: CurrencyMetrics = {
    currencyCode: sales.currencyCode,
    saleCount: sales.saleCount,
    itemsSold: roundQty(sales.itemsSold),
    lineCount: sales.lineCount ?? 0,
    grossSales,
    discounts,
    returnCount: returns.returnCount,
    returns: returnsExTax,
    netSales,
    tax: round2(sales.tax),
    returnTax: round2(returns.returnTax),
    netTax: round2(sales.tax - returns.returnTax),
    averageOrderValue: sales.saleCount ? round2(netSales / sales.saleCount) : 0,
    salesInclTax: round2(sales.totalInclTax),
    refundsInclTax: round2(returns.returnsInclTax),
    totalCollectedInclTax: round2(sales.totalInclTax - returns.returnsInclTax),
  };
  if (showCost) {
    const costOfGoods = round2(sales.costOfGoods - returns.restockedCost);
    const grossProfit = round2(netSales - costOfGoods);
    metrics.costOfGoods = costOfGoods;
    metrics.grossProfit = grossProfit;
    metrics.margin = netSales > 0 ? grossProfit / netSales : null;
  }
  return metrics;
}

/**
 * Metrics for every currency with sales or returns, the store currency first
 * (always present, zero when nothing was sold in it).
 */
export function metricsByCurrency(
  storeCurrency: string,
  sales: SalesAggregate[],
  returns: ReturnsAggregate[],
  showCost: boolean,
): CurrencyMetrics[] {
  const codes = [
    storeCurrency,
    ...new Set(
      [...sales, ...returns]
        .map((row) => row.currencyCode)
        .filter((code) => code !== storeCurrency)
        .sort(),
    ),
  ];
  return codes.map((code) =>
    currencyMetrics(
      sales.find((row) => row.currencyCode === code) ?? emptySales(code),
      returns.find((row) => row.currencyCode === code) ?? emptyReturns(code),
      showCost,
    ),
  );
}
