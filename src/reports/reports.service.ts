import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { SettingsService } from '../settings/settings.service';
import { ReportQueryDto } from './reports.dto';
import {
  ELIGIBLE_RETURN,
  EXCHANGE_CREDIT_METHOD,
  LINE_GROSS_EX_TAX,
  REVENUE_LINE,
  STORED_VALUE_LINE,
  supplierAgingCte,
} from './report-definitions';
import { metricsByCurrency } from './sales-metrics';
import {
  bindParams,
  branchFilter,
  expenseInBranch,
  locationInBranch,
  returnInBranch,
  saleInBranch,
  shiftInBranch,
  type ReportScope,
} from './report-sql';
import { dataFreshness } from './freshness';

const num = (value: unknown) => Number(value ?? 0);

// Sales that happened (later returns don't un-sell them) and payments that took money
export const SOLD_STATUSES = `'completed', 'partially_refunded', 'refunded'`;
export const PAID_STATUSES = `'completed', 'captured', 'refunded'`;

// Aggregates come back from pg as strings (COUNT/bigint) or numbers (NUMERIC,
// see database/pg-types), and SUM over no rows is null
type DbNumber = string | number | null;

interface SalesRow {
  currencyCode: string;
  saleCount: DbNumber;
  itemsSold: DbNumber;
  lineCount: DbNumber;
  grossSalesExTax: DbNumber;
  netLinesExTax: DbNumber;
  tax: DbNumber;
  totalInclTax: DbNumber;
  costOfGoods: DbNumber;
}

interface ReturnsRow {
  currencyCode: string;
  returnCount: DbNumber;
  returnsExTax: DbNumber;
  returnTax: DbNumber;
  returnsInclTax: DbNumber;
  restockedCost: DbNumber;
}

interface ByDayRow {
  date: string;
  saleCount: DbNumber;
  total: DbNumber;
}

interface ByPaymentMethodRow {
  paymentMethodId: string;
  name: string | null;
  methodType: string;
  currencyCode: string;
  count: DbNumber;
  amount: DbNumber;
}

interface TopProductRow {
  variantId: string;
  productName: string;
  variantName: string | null;
  sku: string | null;
  quantity: DbNumber;
  revenue: DbNumber;
}

interface CurrencyAmountRow {
  currencyCode: string;
  amount: DbNumber;
  count: DbNumber;
}

interface ByCashierRow {
  userId: string;
  name: string;
  email: string;
  saleCount: DbNumber;
  total: DbNumber;
}

@Injectable()
export class ReportsService {
  constructor(
    private dataSource: DataSource,
    private settingsService: SettingsService,
  ) {}

  /**
   * Sales summary for a period, per currency (see sales-metrics.ts for the
   * definitions). Sales that were later partly or fully returned still count as
   * sales; returns are taken off by return date. `totals` are in the store
   * currency; sales in other currencies are in `otherCurrencies`, never added in.
   * Cost, gross profit and margin need inventory.cost.view.
   *
   * Every figure is limited to `query.branchId` and to the user's `scope`
   * (branch-limited access); payables are store-wide, so they are only shown
   * without a branch restriction.
   */
  async summary(
    tenantId: string,
    query: ReportQueryDto,
    permissions: readonly string[] = [],
    scope?: ReportScope,
  ) {
    const tz = query.timezone ?? 'UTC';
    const showCost = permissions.includes('inventory.cost.view');
    const showPayables =
      permissions.includes('purchasing.payables') ||
      permissions.includes('purchasing.manage');
    const settings = await this.settingsService.getSettings(tenantId);
    const storeCurrency = settings.currencyCode;
    const branchIds = branchFilter(query.branchId, scope);
    // $1 tenant, $2 from, $3 to, $4 store currency, $5 time zone, $6 branch ids,
    // $7 low stock level — each query binds only what it uses (bindParams)
    const all = [
      tenantId,
      query.from,
      query.to,
      storeCurrency,
      tz,
      branchIds,
      settings.lowStockThreshold,
    ];
    const q = <T>(sql: string) => {
      const bound = bindParams(sql, all);
      return this.dataSource.query<T>(bound.sql, bound.values);
    };
    const completed = `s."tenantId" = $1 AND s."saleDate" >= $2 AND s."saleDate" <= $3 AND s.status IN (${SOLD_STATUSES}) AND ${saleInBranch('$6')}`;
    const returned = `r."tenantId" = $1 AND r.created_at >= $2 AND r.created_at <= $3 AND ${ELIGIBLE_RETURN} AND ${returnInBranch('$6')}`;
    // Only the store currency is charted / ranked; other currencies have their totals
    const inStoreCurrency = `TRIM(s."currencyCode") = $4`;

    const salesRows = await q<SalesRow[]>(
      `SELECT TRIM(s."currencyCode") AS "currencyCode",
              COUNT(DISTINCT i."saleId") AS "saleCount",
              COALESCE(SUM(i.quantity), 0) AS "itemsSold",
              COUNT(i.id) AS "lineCount",
              COALESCE(SUM(${LINE_GROSS_EX_TAX}), 0) AS "grossSalesExTax",
              COALESCE(SUM(i.total - i."taxAmount"), 0) AS "netLinesExTax",
              COALESCE(SUM(i."taxAmount"), 0) AS "tax",
              COALESCE(SUM(i.total), 0) AS "totalInclTax",
              COALESCE(SUM(COALESCE(i.cost, 0) * i.quantity), 0) AS "costOfGoods"
       FROM sales s LEFT JOIN sale_items i ON i."saleId" = s.id AND ${REVENUE_LINE}
       WHERE ${completed}
       GROUP BY 1`,
    );

    // Gift cards sold: stored value (a liability), shown apart from sales
    const giftCardRows = await q<CurrencyAmountRow[]>(
      `SELECT TRIM(s."currencyCode") AS "currencyCode", COALESCE(SUM(i.total), 0) AS amount, COUNT(*) AS count
       FROM sale_items i JOIN sales s ON s.id = i."saleId"
       WHERE ${completed} AND ${STORED_VALUE_LINE}
       GROUP BY 1 ORDER BY 1`,
    );

    // Returns processed in the period (by return date, like a till's day report)
    const returnRows = await q<ReturnsRow[]>(
      `WITH rets AS (
         SELECT r.id, r."currencyCode", r.total, r."taxAmount" FROM sale_returns r WHERE ${returned}
       ), restocked AS (
         -- Restocked items come back into inventory: no longer a cost of sale
         SELECT ri."returnId", SUM(COALESCE(si.cost, 0) * ri.quantity) AS cost
         FROM sale_return_items ri JOIN sale_items si ON si.id = ri."saleItemId"
         WHERE ri."returnId" IN (SELECT id FROM rets) AND ri.disposition = 'restock'
         GROUP BY 1
       )
       SELECT TRIM(r."currencyCode") AS "currencyCode",
              COUNT(*) AS "returnCount",
              COALESCE(SUM(r.total - r."taxAmount"), 0) AS "returnsExTax",
              COALESCE(SUM(r."taxAmount"), 0) AS "returnTax",
              COALESCE(SUM(r.total), 0) AS "returnsInclTax",
              COALESCE(SUM(restocked.cost), 0) AS "restockedCost"
       FROM rets r LEFT JOIN restocked ON restocked."returnId" = r.id
       GROUP BY 1`,
    );

    const byCurrency = metricsByCurrency(
      storeCurrency,
      salesRows.map((row) => ({
        currencyCode: row.currencyCode,
        saleCount: num(row.saleCount),
        itemsSold: num(row.itemsSold),
        lineCount: num(row.lineCount),
        grossSalesExTax: num(row.grossSalesExTax),
        netLinesExTax: num(row.netLinesExTax),
        tax: num(row.tax),
        totalInclTax: num(row.totalInclTax),
        costOfGoods: num(row.costOfGoods),
      })),
      returnRows.map((row) => ({
        currencyCode: row.currencyCode,
        returnCount: num(row.returnCount),
        returnsExTax: num(row.returnsExTax),
        returnTax: num(row.returnTax),
        returnsInclTax: num(row.returnsInclTax),
        restockedCost: num(row.restockedCost),
      })),
      showCost,
    );
    const [storeTotals, ...otherCurrencies] = byCurrency;

    // Net sales (excl. tax) per local day: sales on their day, returns on theirs
    const byDay = await q<ByDayRow[]>(
      `WITH sold AS (
         SELECT (s."saleDate" AT TIME ZONE $5)::date AS day, COUNT(DISTINCT i."saleId") AS "saleCount",
                COALESCE(SUM(i.total - i."taxAmount"), 0) AS net
         FROM sales s LEFT JOIN sale_items i ON i."saleId" = s.id AND ${REVENUE_LINE}
         WHERE ${completed} AND ${inStoreCurrency} GROUP BY 1
       ), returned AS (
         SELECT (r.created_at AT TIME ZONE $5)::date AS day, SUM(r.total - r."taxAmount") AS net
         FROM sale_returns r WHERE ${returned} AND TRIM(r."currencyCode") = $4 GROUP BY 1
       )
       SELECT TO_CHAR(COALESCE(sold.day, returned.day), 'YYYY-MM-DD') AS "date",
              COALESCE(sold."saleCount", 0) AS "saleCount",
              COALESCE(sold.net, 0) - COALESCE(returned.net, 0) AS "total"
       FROM sold FULL OUTER JOIN returned ON returned.day = sold.day
       ORDER BY 1`,
    );

    // Tender mix per currency: payments are in their sale's currency. Exchange
    // credit (returned goods paying for their replacement) moves no money: left out
    const byPaymentMethod = await q<ByPaymentMethodRow[]>(
      `SELECT pm.id AS "paymentMethodId", pm.name->>'en' AS "name", pm."methodType" AS "methodType",
              TRIM(s."currencyCode") AS "currencyCode", COUNT(*) AS "count", SUM(p.amount) AS "amount"
       FROM payments p
       JOIN sales s ON s.id = p."saleId"
       JOIN payment_methods pm ON pm.id = p."paymentMethodId"
       WHERE ${completed} AND p.status IN (${PAID_STATUSES}) AND pm.code <> ${EXCHANGE_CREDIT_METHOD}
       GROUP BY pm.id, TRIM(s."currencyCode") ORDER BY "amount" DESC`,
    );
    const changeRows = await q<{ currencyCode: string; change: DbNumber }[]>(
      `SELECT TRIM(s."currencyCode") AS "currencyCode", COALESCE(SUM(s."changeAmount"), 0) AS "change"
       FROM sales s WHERE ${completed} GROUP BY 1`,
    );

    const topProducts = await q<TopProductRow[]>(
      `SELECT i."variantId", MAX(i."productName") AS "productName", MAX(i."variantName") AS "variantName",
              MAX(i.sku) AS "sku", SUM(i.quantity) AS "quantity", SUM(i.total - i."taxAmount") AS "revenue"
       FROM sale_items i JOIN sales s ON s.id = i."saleId"
       WHERE ${completed} AND ${inStoreCurrency} AND ${REVENUE_LINE}
       GROUP BY i."variantId" ORDER BY "revenue" DESC LIMIT 10`,
    );

    const byCashier = await q<ByCashierRow[]>(
      `SELECT u.id AS "userId", CONCAT_WS(' ', u."firstName", u."lastName") AS "name", u.email,
              COUNT(DISTINCT i."saleId") AS "saleCount", COALESCE(SUM(i.total - i."taxAmount"), 0) AS "total"
       FROM sales s JOIN users u ON u.id = s."userId"
       LEFT JOIN sale_items i ON i."saleId" = s.id AND ${REVENUE_LINE}
       WHERE ${completed} AND ${inStoreCurrency}
       GROUP BY u.id ORDER BY "total" DESC`,
    );

    const [{ voidedCount }] = await q<{ voidedCount: DbNumber }[]>(
      `SELECT COUNT(*) AS "voidedCount" FROM sales s
       WHERE s."tenantId" = $1 AND s."saleDate" >= $2 AND s."saleDate" <= $3 AND s.status = 'voided'
         AND ${saleInBranch('$6')}`,
    );

    // On hand: all stock, or only at the branch's locations
    const [{ lowStockCount }] = await q<{ lowStockCount: DbNumber }[]>(
      `SELECT COUNT(*) AS "lowStockCount" FROM (
         SELECT CASE WHEN $6::uuid[] IS NULL THEN v."stockQuantity"
                  ELSE (SELECT COALESCE(SUM(l."quantityOnHand"), 0) FROM stock_levels l
                        WHERE l."variantId" = v.id AND ${locationInBranch('$6', 'l."locationId"')}) END AS "onHand",
                COALESCE(p."reorderPoint", $7::int) AS "reorderPoint"
         FROM product_variants v JOIN products p ON p.id = v."productId"
         WHERE v."tenantId" = $1 AND v.status = 'active' AND p.status = 'active'
       ) low WHERE low."onHand" <= low."reorderPoint"`,
    );

    // Stock value at cost (cost-gated), in the store currency
    let inventoryValue: number | null = null;
    if (showCost) {
      const [row] = await q<{ value: DbNumber }[]>(
        `SELECT COALESCE(SUM(l."quantityOnHand" * COALESCE(v.cost, 0)), 0) AS value
         FROM stock_levels l JOIN product_variants v ON v.id = l."variantId"
         WHERE l."tenantId" = $1 AND v.status <> 'discontinued'
           AND ${locationInBranch('$6', 'l."locationId"')}`,
      );
      inventoryValue = num(row?.value);
    }

    // Open supplier balances (payables), per supplier currency; store-wide only
    let purchasingObligations:
      { currencyCode: string; balance: number }[] | null = null;
    if (showPayables && !branchIds) {
      const rows = await q<{ currencyCode: string; balance: DbNumber }[]>(
        `${supplierAgingCte('$5')}
         SELECT currency AS "currencyCode", SUM(balance) AS balance FROM aging GROUP BY 1 ORDER BY 1`,
      );
      purchasingObligations = rows.map((row) => ({
        currencyCode: row.currencyCode,
        balance: num(row.balance),
      }));
    }

    // Approved and paid expenses dated in the period, per currency
    const expenseRows = await q<CurrencyAmountRow[]>(
      `SELECT TRIM(e."currencyCode") AS "currencyCode", COALESCE(SUM(e.amount), 0) AS amount, COUNT(*) AS count
       FROM expenses e
       WHERE e."tenantId" = $1 AND e.status IN ('approved', 'paid')
         AND e."expenseDate" >= ($2::timestamptz AT TIME ZONE $5)::date
         AND e."expenseDate" <= ($3::timestamptz AT TIME ZONE $5)::date
         AND ${expenseInBranch('$6')}
       GROUP BY 1 ORDER BY 1`,
    );

    // Cash over / short of the shifts closed in the period, per shift currency
    const varianceRows = await q<CurrencyAmountRow[]>(
      `SELECT TRIM(sh."currencyCode") AS "currencyCode", COALESCE(SUM(sh.variance), 0) AS amount, COUNT(*) AS count
       FROM shifts sh
       WHERE sh."tenantId" = $1 AND sh.status = 'closed'
         AND sh."closedAt" >= $2 AND sh."closedAt" <= $3 AND ${shiftInBranch('$6')}
       GROUP BY 1 ORDER BY 1`,
    );
    const perCurrency = (rows: CurrencyAmountRow[]) =>
      rows.map((row) => ({
        currencyCode: row.currencyCode,
        amount: num(row.amount),
        count: num(row.count),
      }));

    const freshness = await dataFreshness(this.dataSource, tenantId, branchIds);

    // Cash payments include change handed back; report what was actually kept.
    // Change is only ever given from cash, so take it off the cash methods once
    // (per currency: change is given in the sale's currency).
    const changeLeft = new Map(
      changeRows.map((row) => [row.currencyCode, num(row.change)]),
    );
    const payments = byPaymentMethod.map((row) => {
      let amount = num(row.amount);
      const left = changeLeft.get(row.currencyCode) ?? 0;
      if (row.methodType === 'cash' && left > 0) {
        const taken = Math.min(left, amount);
        amount -= taken;
        changeLeft.set(row.currencyCode, left - taken);
      }
      return { ...row, count: num(row.count), amount };
    });

    return {
      period: { from: query.from, to: query.to, timezone: tz },
      // Branches the figures are limited to (null: every branch)
      branchIds,
      generatedAt: freshness.generatedAt,
      // Unsynced till sales: the figures may be incomplete
      freshness,
      currencyCode: storeCurrency,
      costVisible: showCost,
      // Stock value at cost now (null without inventory.cost.view)
      inventoryValue,
      // Open supplier balance per currency (null without payables access or
      // with a branch restriction: payables are store-wide)
      purchasingObligations,
      // Approved / paid expenses dated in the period, per currency
      expenses: perCurrency(expenseRows),
      // Sum of the closed shifts' cash variances, per currency
      cashVariance: perCurrency(varianceRows),
      // Gift cards sold in the period, per currency (stored value: not in sales)
      giftCardsSold: perCurrency(giftCardRows),
      // Store currency
      totals: {
        ...storeTotals,
        voidedCount: num(voidedCount),
        lowStockCount: num(lowStockCount),
      },
      // Sales recorded in other currencies (e.g. a branch selling in HTG)
      otherCurrencies,
      // Store currency only; amounts are net sales excluding tax
      byDay: byDay.map((row) => ({
        date: row.date,
        saleCount: num(row.saleCount),
        total: num(row.total),
      })),
      byPaymentMethod: payments,
      // Store currency only; revenue excludes tax
      topProducts: topProducts.map((row) => ({
        ...row,
        quantity: num(row.quantity),
        revenue: num(row.revenue),
      })),
      // Store currency only; total is net sales excluding tax
      byCashier: byCashier.map((row) => ({
        ...row,
        saleCount: num(row.saleCount),
        total: num(row.total),
      })),
    };
  }
}
