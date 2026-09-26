/**
 * Catalog of tabular reports. Each one is a single SQL query over the tenant's data;
 * the runner binds (only the placeholders a query uses, see bindParams):
 *   $1 = tenantId, $2 = from, $3 = to, $4 = IANA time zone,
 *   $5 = branch ids (uuid[], NULL = every branch — see report-sql.ts),
 *   $6 = variantId, $7 = locationId (reports with `parameters`).
 *
 * Every report either filters on $5 (`branchFilter: true`) or covers the whole
 * store (`branchFilter: false`: refused to branch-limited users).
 *
 * Adding a report: add an entry here — the API, the Reports page and CSV/Excel/PDF
 * export pick it up automatically.
 */
import type { Permission } from '../auth/permissions';
import {
  expenseInBranch,
  locationInBranch,
  registerInBranch,
  returnInBranch,
  saleInBranch,
  shiftInBranch,
} from './report-sql';

// Placeholder of the branch filter (uuid[])
const B = '$5';

export type ColumnType =
  'text' | 'number' | 'money' | 'percent' | 'date' | 'datetime';

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
  // Summed in the totals row (money only while every row is in one currency)
  total?: boolean;
  // Dropped from the report (and its exports) for users without this permission
  requires?: Permission;
  // Values come from a fixed set (statuses, movement types): the UI translates them
  translate?: boolean;
}

export interface ReportParameter {
  key: 'variantId' | 'locationId';
  label: string;
  required: boolean;
}

export type ReportGroup =
  | 'Sales'
  | 'Payments & tax'
  | 'Returns & voids'
  | 'Inventory'
  | 'Cash'
  | 'Purchasing'
  | 'Expenses'
  | 'Customers'
  | 'Administration';

// Column holding each row's currency: money is never totalled across currencies
export const CURRENCY_COLUMN = 'currency';

export interface ReportDefinition {
  key: string;
  title: string;
  description: string;
  group: ReportGroup;
  // false: a snapshot (e.g. stock), the date range is ignored
  usesDateRange: boolean;
  // true: the SQL filters on the branch ids ($5); false: store-wide figures
  branchFilter: boolean;
  // Needed to run the report at all (any one of them), on top of reports.view
  requires?: Permission[];
  // Extra inputs ($6 variantId, $7 locationId)
  parameters?: ReportParameter[];
  columns: ReportColumn[];
  sql: string;
}

// Sales that happened (later returns don't un-sell them) and payments that took money
const SOLD = `s.status IN ('completed', 'partially_refunded', 'refunded')`;
const PAID = `p.status IN ('completed', 'captured', 'refunded')`;
// Sales rung up in the period at the selected branches
const IN_PERIOD = `s."tenantId" = $1 AND s."saleDate" >= $2 AND s."saleDate" <= $3 AND ${saleInBranch(B)}`;
// A return reverses its sale once stock and records are posted, whatever the state
// of the refund payment (a failed card refund is still owed to the customer)
export const ELIGIBLE_RETURN = `r.status::text IN ('completed', 'refund_pending', 'refund_failed')`;
// Returns processed in the period at the selected branches
const RETURNS_IN_PERIOD = `r."tenantId" = $1 AND r.created_at >= $2 AND r.created_at <= $3 AND ${ELIGIBLE_RETURN} AND ${returnInBranch(B)}`;
const PERSON = (u: string) =>
  `COALESCE(NULLIF(CONCAT_WS(' ', ${u}."firstName", ${u}."lastName"), ''), ${u}.email)`;
const BRANCH_NAME = (branchId: string) =>
  `(SELECT b.name FROM branches b WHERE b.id = ${branchId})`;
const REGISTER_NAME = (registerId: string) =>
  `(SELECT rn.name FROM registers rn WHERE rn.id = ${registerId})`;
const PRICES_INCLUDE_TAX = `(SELECT COALESCE((t.settings->>'pricesIncludeTax')::boolean, false) FROM tenants t WHERE t.id = $1)`;
/**
 * A sale line's pre-discount value excluding tax (quantity × list price, ex. tax).
 * Line net ex. tax is total − tax in both tax modes; the pre-discount value is
 * scaled by the same ex-tax share. A fully discounted line has no net value to
 * measure that share on, so it falls back to the store's tax mode and the line rate.
 */
export const LINE_GROSS_EX_TAX = `(i.subtotal * CASE
    WHEN i.subtotal - i."discountAmount" <> 0 THEN (i.total - i."taxAmount") / (i.subtotal - i."discountAmount")
    WHEN ${PRICES_INCLUDE_TAX} THEN 1 / (1 + COALESCE(i."taxRate", 0) / 100)
    ELSE 1 END)`;
const LINE_NET_EX_TAX = `(i.total - i."taxAmount")`;
/**
 * Gift cards sold are stored value (a liability), not revenue: their lines
 * (metadata.storedValue = true) stay out of gross / net sales, tax and product /
 * category figures. The dashboard shows them apart ("Gift cards sold").
 */
export const REVENUE_LINE = `COALESCE((i.metadata->>'storedValue')::boolean, false) = false`;
export const STORED_VALUE_LINE = `COALESCE((i.metadata->>'storedValue')::boolean, false) = true`;
/**
 * Exchange credit (returned goods paying for their replacement) is an internal,
 * non-cash tender: no money changed hands, so it is left out of the tender mix.
 */
export const EXCHANGE_CREDIT_METHOD = `'EXCHANGE_CREDIT'`;
const NOT_EXCHANGE_CREDIT = (paymentMethodId: string) =>
  `NOT EXISTS (SELECT 1 FROM payment_methods xm WHERE xm.id = ${paymentMethodId} AND xm.code = ${EXCHANGE_CREDIT_METHOD})`;
// Sales filed under a closed shift after it closed (e.g. offline sales uploaded late)
export const LATE_SALE_OF_SHIFT = `s."tenantId" = sh."tenantId" AND s."registerId" = sh."registerId"
  AND sh.status = 'closed' AND s.created_at > sh."closedAt" AND ${SOLD}
  AND (s."shiftId" = sh.id OR (s."shiftId" IS NULL AND s."saleDate" >= sh."openedAt" AND s."saleDate" <= sh."closedAt"))`;

// Units of transfer item `ti` still in transit (see inventory/transfer.logic.ts)
const TRANSIT = `GREATEST(ti."quantityDispatched" - ti."quantityReceived" - COALESCE(ti."quantityDamaged", 0)
  - ti."quantityWrittenOff" - COALESCE(ti."quantityReturned", 0), 0)`;

/**
 * Supplier aging as of today in the store time zone (`tz` placeholder), per supplier: the rules
 * of purchasing/payables (computeAging): invoices not void dated up to today,
 * posted payments and open credits allocated to them, what is left unapplied.
 * Defines a CTE `aging`; money in the supplier's currency.
 */
export const supplierAgingCte = (tz: string) => `
  WITH asof AS (SELECT (now() AT TIME ZONE ${tz})::date AS d),
  inv AS (
    SELECT i.id, i."supplierId", i."dueDate", i.total FROM supplier_invoices i, asof
    WHERE i."tenantId" = $1 AND i.status <> 'void' AND i."invoiceDate" <= asof.d
  ), src AS (
    SELECT p.id, p."supplierId", p.amount FROM supplier_payments p, asof
    WHERE p."tenantId" = $1 AND p.status = 'posted' AND p."paymentDate" <= asof.d
    UNION ALL
    SELECT c.id, c."supplierId", c.amount FROM supplier_credits c, asof
    WHERE c."tenantId" = $1 AND c.status = 'open' AND c."creditDate" <= asof.d
  ), alloc AS (
    SELECT a."invoiceId", COALESCE(a."paymentId", a."creditId") AS "sourceId", a.amount
    FROM supplier_allocations a
    WHERE a."tenantId" = $1 AND a."invoiceId" IN (SELECT id FROM inv)
      AND COALESCE(a."paymentId", a."creditId") IN (SELECT id FROM src)
  ), open_inv AS (
    SELECT inv."supplierId", asof.d - inv."dueDate" AS overdue,
           GREATEST(inv.total - COALESCE((SELECT SUM(al.amount) FROM alloc al WHERE al."invoiceId" = inv.id), 0), 0) AS open
    FROM inv, asof
  ), buckets AS (
    SELECT "supplierId",
           COALESCE(SUM(open) FILTER (WHERE overdue <= 0), 0) AS current,
           COALESCE(SUM(open) FILTER (WHERE overdue BETWEEN 1 AND 30), 0) AS "days1to30",
           COALESCE(SUM(open) FILTER (WHERE overdue BETWEEN 31 AND 60), 0) AS "days31to60",
           COALESCE(SUM(open) FILTER (WHERE overdue BETWEEN 61 AND 90), 0) AS "days61to90",
           COALESCE(SUM(open) FILTER (WHERE overdue > 90), 0) AS over90,
           COALESCE(SUM(open), 0) AS owed
    FROM open_inv GROUP BY 1
  ), unapplied AS (
    SELECT left_over."supplierId", SUM(left_over.remaining) AS amount
    FROM (
      SELECT src."supplierId",
             src.amount - COALESCE((SELECT SUM(al.amount) FROM alloc al WHERE al."sourceId" = src.id), 0) AS remaining
      FROM src
    ) left_over GROUP BY 1
  ), aging AS (
    SELECT sp.code, sp.name AS supplier, TRIM(sp."currencyCode") AS currency,
           COALESCE(b.current, 0) AS current, COALESCE(b."days1to30", 0) AS "days1to30",
           COALESCE(b."days31to60", 0) AS "days31to60", COALESCE(b."days61to90", 0) AS "days61to90",
           COALESCE(b.over90, 0) AS over90, COALESCE(u.amount, 0) AS unapplied,
           COALESCE(b.owed, 0) - COALESCE(u.amount, 0) AS balance
    FROM suppliers sp
    LEFT JOIN buckets b ON b."supplierId" = sp.id
    LEFT JOIN unapplied u ON u."supplierId" = sp.id
    WHERE sp."tenantId" = $1 AND (COALESCE(b.owed, 0) <> 0 OR COALESCE(u.amount, 0) <> 0)
  )`;

// Units on hand of variant `v`: all stock, or only at the selected branches' locations
export const ON_HAND_AT_BRANCH = `CASE WHEN ${B}::uuid[] IS NULL THEN v."stockQuantity"
  ELSE (SELECT COALESCE(SUM(l."quantityOnHand"), 0) FROM stock_levels l
        WHERE l."variantId" = v.id AND ${locationInBranch(B, 'l."locationId"')}) END`;

export const REPORTS: ReportDefinition[] = [
  {
    key: 'sales-by-day',
    title: 'Sales by day',
    description:
      'Daily gross sales, discounts, returns and net sales excluding tax, per currency (store time zone).',
    group: 'Sales',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'date', label: 'Date', type: 'date' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'saleCount', label: 'Sales', type: 'number', total: true },
      {
        key: 'grossSales',
        label: 'Gross sales (excl. tax)',
        type: 'money',
        total: true,
      },
      {
        key: 'discounts',
        label: 'Discounts (excl. tax)',
        type: 'money',
        total: true,
      },
      {
        key: 'returns',
        label: 'Returns (excl. tax)',
        type: 'money',
        total: true,
      },
      {
        key: 'netSales',
        label: 'Net sales (excl. tax)',
        type: 'money',
        total: true,
      },
      { key: 'netTax', label: 'Net tax', type: 'money', total: true },
      {
        key: 'collected',
        label: 'Total collected (incl. tax)',
        type: 'money',
        total: true,
      },
    ],
    sql: `
      WITH sold AS (
        SELECT (s."saleDate" AT TIME ZONE $4)::date AS day, TRIM(s."currencyCode") AS currency,
               COUNT(DISTINCT i."saleId") AS "saleCount",
               COALESCE(SUM(${LINE_GROSS_EX_TAX}), 0) AS "grossSales",
               COALESCE(SUM(${LINE_NET_EX_TAX}), 0) AS net,
               COALESCE(SUM(i."taxAmount"), 0) AS tax, COALESCE(SUM(i.total), 0) AS total
        FROM sales s LEFT JOIN sale_items i ON i."saleId" = s.id AND ${REVENUE_LINE}
        WHERE ${IN_PERIOD} AND ${SOLD} GROUP BY 1, 2
      ), refunded AS (
        SELECT (r.created_at AT TIME ZONE $4)::date AS day, TRIM(r."currencyCode") AS currency,
               SUM(r.total - r."taxAmount") AS net, SUM(r."taxAmount") AS tax, SUM(r.total) AS total
        FROM sale_returns r WHERE ${RETURNS_IN_PERIOD} GROUP BY 1, 2
      )
      SELECT TO_CHAR(COALESCE(sold.day, refunded.day), 'YYYY-MM-DD') AS date,
             COALESCE(sold.currency, refunded.currency) AS currency,
             COALESCE(sold."saleCount", 0) AS "saleCount",
             COALESCE(sold."grossSales", 0) AS "grossSales",
             COALESCE(sold."grossSales", 0) - COALESCE(sold.net, 0) AS discounts,
             COALESCE(refunded.net, 0) AS returns,
             COALESCE(sold.net, 0) - COALESCE(refunded.net, 0) AS "netSales",
             COALESCE(sold.tax, 0) - COALESCE(refunded.tax, 0) AS "netTax",
             COALESCE(sold.total, 0) - COALESCE(refunded.total, 0) AS collected
      FROM sold FULL OUTER JOIN refunded ON refunded.day = sold.day AND refunded.currency = sold.currency
      ORDER BY 1, 2`,
  },
  {
    key: 'sales-by-product',
    title: 'Sales by product',
    description:
      'Units, revenue, returns, cost and gross profit per item sold, per currency.',
    group: 'Sales',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'sku', label: 'SKU', type: 'text' },
      { key: 'product', label: 'Product', type: 'text' },
      { key: 'variant', label: 'Variant', type: 'text' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'quantity', label: 'Sold', type: 'number', total: true },
      { key: 'returned', label: 'Returned', type: 'number', total: true },
      {
        key: 'revenue',
        label: 'Revenue (incl. tax)',
        type: 'money',
        total: true,
      },
      {
        key: 'revenueExTax',
        label: 'Revenue (excl. tax)',
        type: 'money',
        total: true,
      },
      {
        key: 'cost',
        label: 'Cost',
        type: 'money',
        total: true,
        requires: 'inventory.cost.view',
      },
      {
        key: 'profit',
        label: 'Gross profit',
        type: 'money',
        total: true,
        requires: 'inventory.cost.view',
      },
      {
        key: 'margin',
        label: 'Margin',
        type: 'percent',
        requires: 'inventory.cost.view',
      },
    ],
    sql: `
      WITH sold AS (
        SELECT i."variantId", TRIM(s."currencyCode") AS currency, MAX(i.sku) AS sku,
               MAX(i."productName") AS product, MAX(i."variantName") AS variant,
               SUM(i.quantity) AS quantity, SUM(i.total) AS revenue,
               SUM(${LINE_NET_EX_TAX}) AS "revenueExTax", SUM(COALESCE(i.cost, 0) * i.quantity) AS cost
        FROM sale_items i JOIN sales s ON s.id = i."saleId"
        WHERE ${IN_PERIOD} AND ${SOLD} AND ${REVENUE_LINE} GROUP BY 1, 2
      ), returned AS (
        SELECT ri."variantId", TRIM(r."currencyCode") AS currency, SUM(ri.quantity) AS returned
        FROM sale_return_items ri JOIN sale_returns r ON r.id = ri."returnId"
        WHERE ${RETURNS_IN_PERIOD} GROUP BY 1, 2
      )
      SELECT sold.sku, sold.product, sold.variant, sold.currency, sold.quantity,
             COALESCE(returned.returned, 0) AS returned, sold.revenue, sold."revenueExTax", sold.cost,
             sold."revenueExTax" - sold.cost AS profit,
             CASE WHEN sold."revenueExTax" > 0 THEN (sold."revenueExTax" - sold.cost) / sold."revenueExTax" END AS margin
      FROM sold LEFT JOIN returned ON returned."variantId" = sold."variantId" AND returned.currency = sold.currency
      ORDER BY sold.currency, sold.revenue DESC`,
  },
  {
    key: 'sales-by-category',
    title: 'Sales by category',
    description: 'Units and revenue per product category, per currency.',
    group: 'Sales',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'category', label: 'Category', type: 'text' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'quantity', label: 'Units sold', type: 'number', total: true },
      {
        key: 'revenue',
        label: 'Revenue (incl. tax)',
        type: 'money',
        total: true,
      },
      {
        key: 'revenueExTax',
        label: 'Revenue (excl. tax)',
        type: 'money',
        total: true,
      },
      { key: 'share', label: 'Share of revenue', type: 'percent' },
    ],
    sql: `
      SELECT COALESCE(c.name->>'en', 'Uncategorised') AS category, TRIM(s."currencyCode") AS currency,
             SUM(i.quantity) AS quantity, SUM(i.total) AS revenue, SUM(${LINE_NET_EX_TAX}) AS "revenueExTax",
             SUM(${LINE_NET_EX_TAX}) / NULLIF(SUM(SUM(${LINE_NET_EX_TAX})) OVER (PARTITION BY TRIM(s."currencyCode")), 0) AS share
      FROM sale_items i
      JOIN sales s ON s.id = i."saleId"
      JOIN product_variants v ON v.id = i."variantId"
      JOIN products p ON p.id = v."productId"
      LEFT JOIN categories c ON c.id = p."categoryId"
      WHERE ${IN_PERIOD} AND ${SOLD} AND ${REVENUE_LINE}
      GROUP BY 1, 2 ORDER BY 2, revenue DESC`,
  },
  {
    key: 'sales-by-cashier',
    title: 'Sales by cashier',
    description:
      'Sales, average sale, refunds and voids per staff member and currency (sales excl. tax).',
    group: 'Sales',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'cashier', label: 'Cashier', type: 'text' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'saleCount', label: 'Sales', type: 'number', total: true },
      {
        key: 'total',
        label: 'Sales (excl. tax)',
        type: 'money',
        total: true,
      },
      {
        key: 'averageSale',
        label: 'Average sale (excl. tax)',
        type: 'money',
      },
      {
        key: 'discounts',
        label: 'Discounts given (excl. tax)',
        type: 'money',
        total: true,
      },
      {
        key: 'refunds',
        label: 'Refunds processed (incl. tax)',
        type: 'money',
        total: true,
      },
      { key: 'voids', label: 'Voids', type: 'number', total: true },
    ],
    sql: `
      WITH sold AS (
        SELECT s."userId", TRIM(s."currencyCode") AS currency, COUNT(DISTINCT i."saleId") AS "saleCount",
               COALESCE(SUM(${LINE_NET_EX_TAX}), 0) AS net,
               COALESCE(SUM(${LINE_GROSS_EX_TAX} - ${LINE_NET_EX_TAX}), 0) AS discounts
        FROM sales s LEFT JOIN sale_items i ON i."saleId" = s.id AND ${REVENUE_LINE}
        WHERE ${IN_PERIOD} AND ${SOLD} GROUP BY 1, 2
      ), refunded AS (
        SELECT r."userId", TRIM(r."currencyCode") AS currency, SUM(r.total) AS refunds
        FROM sale_returns r WHERE ${RETURNS_IN_PERIOD} GROUP BY 1, 2
      ), voided AS (
        SELECT s."userId", TRIM(s."currencyCode") AS currency, COUNT(*) AS voids
        FROM sales s WHERE ${IN_PERIOD} AND s.status = 'voided' GROUP BY 1, 2
      ), people AS (
        SELECT "userId", currency FROM sold
        UNION SELECT "userId", currency FROM refunded
        UNION SELECT "userId", currency FROM voided
      )
      SELECT COALESCE(NULLIF(CONCAT_WS(' ', u."firstName", u."lastName"), ''), u.email) AS cashier,
             people.currency, COALESCE(sold."saleCount", 0) AS "saleCount", COALESCE(sold.net, 0) AS total,
             sold.net / NULLIF(sold."saleCount", 0) AS "averageSale",
             COALESCE(sold.discounts, 0) AS discounts, COALESCE(refunded.refunds, 0) AS refunds,
             COALESCE(voided.voids, 0) AS voids
      FROM people
      JOIN users u ON u.id = people."userId"
      LEFT JOIN sold ON sold."userId" = people."userId" AND sold.currency = people.currency
      LEFT JOIN refunded ON refunded."userId" = people."userId" AND refunded.currency = people.currency
      LEFT JOIN voided ON voided."userId" = people."userId" AND voided.currency = people.currency
      ORDER BY people.currency, total DESC`,
  },
  {
    key: 'payments-by-method',
    title: 'Payments by method',
    description:
      'Tender mix: money taken and refunded per payment method and currency (cash net of change). Exchange credit is an internal tender and is not listed.',
    group: 'Payments & tax',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'method', label: 'Payment method', type: 'text' },
      { key: 'type', label: 'Type', type: 'text' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'count', label: 'Payments', type: 'number', total: true },
      { key: 'taken', label: 'Taken', type: 'money', total: true },
      { key: 'refunded', label: 'Refunded', type: 'money', total: true },
      { key: 'net', label: 'Net', type: 'money', total: true },
    ],
    sql: `
      WITH taken AS (
        SELECT p."paymentMethodId" AS id, TRIM(s."currencyCode") AS currency, COUNT(*) AS count, SUM(p.amount) AS amount
        FROM payments p JOIN sales s ON s.id = p."saleId"
        WHERE ${IN_PERIOD} AND ${SOLD} AND ${PAID} GROUP BY 1, 2
      ), change AS (
        SELECT TRIM(s."currencyCode") AS currency, COALESCE(SUM(s."changeAmount"), 0) AS amount
        FROM sales s WHERE ${IN_PERIOD} AND ${SOLD} GROUP BY 1
      ), refunded AS (
        SELECT rf."paymentMethodId" AS id, TRIM(r."currencyCode") AS currency, SUM(rf.amount) AS amount
        FROM sale_return_refunds rf JOIN sale_returns r ON r.id = rf."returnId"
        WHERE ${RETURNS_IN_PERIOD} AND rf.status <> 'failed' GROUP BY 1, 2
      ), keys AS (
        SELECT id, currency FROM taken UNION SELECT id, currency FROM refunded
      )
      SELECT pm.name->>'en' AS method, pm."methodType" AS type, keys.currency, COALESCE(taken.count, 0) AS count,
             -- change is only ever given in cash, in the sale's currency
             COALESCE(taken.amount, 0) - CASE WHEN pm."methodType" = 'cash'
               THEN COALESCE(change.amount, 0) ELSE 0 END AS taken,
             COALESCE(refunded.amount, 0) AS refunded,
             COALESCE(taken.amount, 0) - CASE WHEN pm."methodType" = 'cash'
               THEN COALESCE(change.amount, 0) ELSE 0 END - COALESCE(refunded.amount, 0) AS net
      FROM keys
      JOIN payment_methods pm ON pm.id = keys.id AND pm."tenantId" = $1
        AND pm.code <> ${EXCHANGE_CREDIT_METHOD}
      LEFT JOIN taken ON taken.id = keys.id AND taken.currency = keys.currency
      LEFT JOIN refunded ON refunded.id = keys.id AND refunded.currency = keys.currency
      LEFT JOIN change ON change.currency = keys.currency
      ORDER BY keys.currency, net DESC`,
  },
  {
    key: 'payments-by-currency',
    title: 'Payments by currency',
    description:
      'Money taken in each currency (e.g. USD and HTG): amount handed over, change given back, and its value in the currency of the sale.',
    group: 'Payments & tax',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'tenderedCurrency', label: 'Tendered currency', type: 'text' },
      { key: 'currency', label: 'Sale currency', type: 'text' },
      { key: 'count', label: 'Payments', type: 'number', total: true },
      { key: 'tendered', label: 'Tendered (in currency)', type: 'number' },
      { key: 'change', label: 'Change given (in currency)', type: 'number' },
      { key: 'net', label: 'Kept (in currency)', type: 'number' },
      {
        key: 'value',
        label: 'Value in sale currency',
        type: 'money',
        total: true,
      },
      { key: 'averageRate', label: 'Average rate', type: 'number' },
    ],
    // p.amount is in the sale's currency: rows are per tendered currency AND sale
    // currency, so values in different currencies are never added together
    sql: `
      WITH paid AS (
        SELECT TRIM(COALESCE(p."tenderedCurrency", p."currencyCode", s."currencyCode")) AS tendered,
               TRIM(s."currencyCode") AS currency,
               COUNT(*) AS count,
               SUM(COALESCE(p."tenderedAmount", p.amount)) AS "tenderedAmount",
               SUM(p.amount) AS value,
               AVG(p."exchangeRate") AS rate
        FROM payments p JOIN sales s ON s.id = p."saleId"
        WHERE ${IN_PERIOD} AND ${SOLD} AND ${PAID} AND ${NOT_EXCHANGE_CREDIT('p."paymentMethodId"')} GROUP BY 1, 2
      ), change AS (
        SELECT TRIM(COALESCE(s.metadata->'changeTender'->>'currencyCode', s."currencyCode")) AS tendered,
               TRIM(s."currencyCode") AS currency,
               SUM(COALESCE((s.metadata->'changeTender'->>'amount')::numeric, s."changeAmount")) AS amount,
               SUM(s."changeAmount") AS value
        FROM sales s
        WHERE ${IN_PERIOD} AND ${SOLD} AND s."changeAmount" > 0 GROUP BY 1, 2
      )
      -- Full join: change may be handed back in a currency nobody paid with
      SELECT COALESCE(paid.tendered, change.tendered) AS "tenderedCurrency",
             COALESCE(paid.currency, change.currency) AS currency,
             COALESCE(paid.count, 0) AS count,
             ROUND(COALESCE(paid."tenderedAmount", 0), 2) AS tendered,
             ROUND(COALESCE(change.amount, 0), 2) AS change,
             ROUND(COALESCE(paid."tenderedAmount", 0) - COALESCE(change.amount, 0), 2) AS net,
             COALESCE(paid.value, 0) - COALESCE(change.value, 0) AS value,
             ROUND(paid.rate, 4) AS "averageRate"
      FROM paid FULL JOIN change ON change.tendered = paid.tendered AND change.currency = paid.currency
      ORDER BY 2, value DESC`,
  },
  {
    key: 'tax',
    title: 'Tax summary',
    description:
      'Taxable sales and tax collected per rate and currency, less tax refunded on returns.',
    group: 'Payments & tax',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'rate', label: 'Tax rate %', type: 'number' },
      {
        key: 'taxable',
        label: 'Taxable sales (excl. tax)',
        type: 'money',
        total: true,
      },
      { key: 'tax', label: 'Tax collected', type: 'money', total: true },
      { key: 'refundedTax', label: 'Tax refunded', type: 'money', total: true },
      { key: 'netTax', label: 'Net tax', type: 'money', total: true },
    ],
    sql: `
      WITH collected AS (
        SELECT TRIM(s."currencyCode") AS currency, COALESCE(i."taxRate", 0) AS rate,
               SUM(${LINE_NET_EX_TAX}) AS taxable, SUM(i."taxAmount") AS tax
        FROM sale_items i JOIN sales s ON s.id = i."saleId"
        WHERE ${IN_PERIOD} AND ${SOLD} AND ${REVENUE_LINE} GROUP BY 1, 2
      ), refunded AS (
        SELECT TRIM(r."currencyCode") AS currency, COALESCE(si."taxRate", 0) AS rate, SUM(ri."taxAmount") AS tax
        FROM sale_return_items ri
        JOIN sale_returns r ON r.id = ri."returnId"
        JOIN sale_items si ON si.id = ri."saleItemId"
        WHERE ${RETURNS_IN_PERIOD} GROUP BY 1, 2
      )
      SELECT COALESCE(collected.currency, refunded.currency) AS currency,
             COALESCE(collected.rate, refunded.rate) AS rate, COALESCE(collected.taxable, 0) AS taxable,
             COALESCE(collected.tax, 0) AS tax, COALESCE(refunded.tax, 0) AS "refundedTax",
             COALESCE(collected.tax, 0) - COALESCE(refunded.tax, 0) AS "netTax"
      FROM collected FULL OUTER JOIN refunded
        ON refunded.rate = collected.rate AND refunded.currency = collected.currency
      ORDER BY 1, 2`,
  },
  {
    key: 'discounts',
    title: 'Discounts given',
    description: 'Every sale with a discount: who gave it and how much.',
    group: 'Payments & tax',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'saleNumber', label: 'Sale', type: 'text' },
      { key: 'date', label: 'Date', type: 'datetime' },
      { key: 'branch', label: 'Branch', type: 'text' },
      { key: 'register', label: 'Register', type: 'text' },
      { key: 'cashier', label: 'Cashier', type: 'text' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'subtotal', label: 'Before discount', type: 'money', total: true },
      { key: 'discount', label: 'Discount', type: 'money', total: true },
      { key: 'discountPercent', label: 'Discount %', type: 'percent' },
      { key: 'total', label: 'Sale total', type: 'money', total: true },
    ],
    sql: `
      SELECT s."saleNumber", s."saleDate" AS date,
             ${BRANCH_NAME('s."branchId"')} AS branch, ${REGISTER_NAME('s."registerId"')} AS register,
             ${PERSON('u')} AS cashier,
             TRIM(s."currencyCode") AS currency, s.subtotal, s."discountAmount" AS discount,
             s."discountAmount" / NULLIF(s.subtotal, 0) AS "discountPercent", s.total
      FROM sales s JOIN users u ON u.id = s."userId"
      WHERE ${IN_PERIOD} AND ${SOLD} AND s."discountAmount" > 0
      ORDER BY s."saleDate" DESC`,
  },
  {
    key: 'refunds',
    title: 'Returns & refunds',
    description:
      'Every return in the period with its reason, approver and refund status.',
    group: 'Returns & voids',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'returnNumber', label: 'Return', type: 'text' },
      { key: 'date', label: 'Date', type: 'datetime' },
      { key: 'saleNumber', label: 'Original sale', type: 'text' },
      { key: 'branch', label: 'Branch', type: 'text' },
      { key: 'register', label: 'Register', type: 'text' },
      { key: 'reason', label: 'Reason', type: 'text' },
      { key: 'processedBy', label: 'Processed by', type: 'text' },
      { key: 'approvedBy', label: 'Approved by', type: 'text' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'items', label: 'Items', type: 'number', total: true },
      { key: 'total', label: 'Refunded', type: 'money', total: true },
      { key: 'status', label: 'Status', type: 'text', translate: true },
    ],
    sql: `
      SELECT r."returnNumber", r.created_at AS date, s."saleNumber",
             (SELECT b.name FROM registers rr JOIN branches b ON b.id = rr."branchId" WHERE rr.id = r."registerId") AS branch,
             ${REGISTER_NAME('r."registerId"')} AS register, r.reason,
             COALESCE(NULLIF(CONCAT_WS(' ', u."firstName", u."lastName"), ''), u.email) AS "processedBy",
             COALESCE(NULLIF(CONCAT_WS(' ', a."firstName", a."lastName"), ''), a.email) AS "approvedBy",
             TRIM(r."currencyCode") AS currency,
             (SELECT SUM(ri.quantity) FROM sale_return_items ri WHERE ri."returnId" = r.id) AS items,
             r.total, r.status
      FROM sale_returns r
      JOIN sales s ON s.id = r."originalSaleId"
      JOIN users u ON u.id = r."userId"
      LEFT JOIN users a ON a.id = r."approverId"
      WHERE ${RETURNS_IN_PERIOD}
      ORDER BY r.created_at DESC`,
  },
  {
    key: 'voids',
    title: 'Voided sales',
    description: 'Sales cancelled after completion, with who rang them up.',
    group: 'Returns & voids',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'saleNumber', label: 'Sale', type: 'text' },
      { key: 'date', label: 'Date', type: 'datetime' },
      { key: 'branch', label: 'Branch', type: 'text' },
      { key: 'register', label: 'Register', type: 'text' },
      { key: 'cashier', label: 'Cashier', type: 'text' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'total', label: 'Total', type: 'money', total: true },
      { key: 'notes', label: 'Notes / reason', type: 'text' },
    ],
    sql: `
      SELECT s."saleNumber", s."saleDate" AS date,
             ${BRANCH_NAME('s."branchId"')} AS branch, ${REGISTER_NAME('s."registerId"')} AS register,
             ${PERSON('u')} AS cashier,
             TRIM(s."currencyCode") AS currency, s.total, s.notes
      FROM sales s JOIN users u ON u.id = s."userId"
      WHERE ${IN_PERIOD} AND s.status = 'voided'
      ORDER BY s."saleDate" DESC`,
  },
  {
    key: 'inventory-valuation',
    title: 'Inventory valuation',
    description:
      'Stock on hand per item right now, at cost (with cost access) and at retail price.',
    group: 'Inventory',
    usesDateRange: false,
    branchFilter: true,
    columns: [
      { key: 'sku', label: 'SKU', type: 'text' },
      { key: 'product', label: 'Product', type: 'text' },
      { key: 'variant', label: 'Variant', type: 'text' },
      { key: 'onHand', label: 'On hand', type: 'number', total: true },
      {
        key: 'unitCost',
        label: 'Unit cost',
        type: 'money',
        requires: 'inventory.cost.view',
      },
      {
        key: 'value',
        label: 'Stock value (cost)',
        type: 'money',
        total: true,
        requires: 'inventory.cost.view',
      },
      { key: 'retailValue', label: 'Retail value', type: 'money', total: true },
    ],
    sql: `
      SELECT v.sku, p.name->>'en' AS product, v.name->>'en' AS variant,
             COALESCE(SUM(l."quantityOnHand"), 0) AS "onHand", COALESCE(v.cost, 0) AS "unitCost",
             COALESCE(SUM(l."quantityOnHand"), 0) * COALESCE(v.cost, 0) AS value,
             COALESCE(SUM(l."quantityOnHand"), 0) * COALESCE(v.price, 0) AS "retailValue"
      FROM product_variants v
      JOIN products p ON p.id = v."productId"
      LEFT JOIN stock_levels l ON l."variantId" = v.id AND ${locationInBranch(B, 'l."locationId"')}
      WHERE v."tenantId" = $1 AND v.status <> 'discontinued'
      GROUP BY v.id, p.id
      ORDER BY "onHand" DESC, v.sku`,
  },
  {
    key: 'low-stock',
    title: 'Low stock',
    description:
      'Items at or below their reorder point (or the store low-stock level).',
    group: 'Inventory',
    usesDateRange: false,
    branchFilter: true,
    columns: [
      { key: 'sku', label: 'SKU', type: 'text' },
      { key: 'product', label: 'Product', type: 'text' },
      { key: 'variant', label: 'Variant', type: 'text' },
      { key: 'onHand', label: 'On hand', type: 'number' },
      { key: 'reorderPoint', label: 'Reorder point', type: 'number' },
      { key: 'reorderQuantity', label: 'Suggested order', type: 'number' },
    ],
    sql: `
      SELECT * FROM (
        SELECT v.sku, p.name->>'en' AS product, v.name->>'en' AS variant, ${ON_HAND_AT_BRANCH} AS "onHand",
               COALESCE(p."reorderPoint", (SELECT COALESCE((t.settings->>'lowStockThreshold')::int, 5) FROM tenants t WHERE t.id = $1)) AS "reorderPoint",
               p."reorderQuantity"
        FROM product_variants v JOIN products p ON p.id = v."productId"
        WHERE v."tenantId" = $1 AND v.status = 'active' AND p.status = 'active'
      ) low
      WHERE low."onHand" <= low."reorderPoint"
      ORDER BY low."onHand" ASC`,
  },
  {
    key: 'shifts',
    title: 'Shifts & cash variance',
    description:
      'Register shifts with opening float, expected and counted cash (frozen at close), and sales uploaded after the close.',
    group: 'Cash',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'shiftNumber', label: 'Shift', type: 'text' },
      { key: 'branch', label: 'Branch', type: 'text' },
      { key: 'register', label: 'Register', type: 'text' },
      { key: 'openedBy', label: 'Opened by', type: 'text' },
      { key: 'openedAt', label: 'Opened', type: 'datetime' },
      { key: 'closedAt', label: 'Closed', type: 'datetime' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'openingFloat', label: 'Float', type: 'money' },
      { key: 'expectedCash', label: 'Expected', type: 'money', total: true },
      { key: 'countedCash', label: 'Counted', type: 'money', total: true },
      { key: 'variance', label: 'Variance', type: 'money', total: true },
      {
        key: 'lateSales',
        label: 'Sales uploaded after close',
        type: 'number',
        total: true,
      },
      {
        key: 'lateCash',
        label: 'Cash uploaded after close',
        type: 'money',
        total: true,
      },
      { key: 'status', label: 'Status', type: 'text', translate: true },
    ],
    // Expected / counted / variance are the figures frozen when the shift closed;
    // late uploads are shown next to them, never folded in
    sql: `
      SELECT sh."shiftNumber", ${BRANCH_NAME('COALESCE(sh."branchId", rg."branchId")')} AS branch, rg.name AS register,
             COALESCE(NULLIF(CONCAT_WS(' ', u."firstName", u."lastName"), ''), u.email) AS "openedBy",
             sh."openedAt", sh."closedAt", TRIM(sh."currencyCode") AS currency,
             sh."openingFloat", sh."expectedCash", sh."countedCash", sh.variance,
             (SELECT COUNT(*) FROM sales s WHERE ${LATE_SALE_OF_SHIFT}) AS "lateSales",
             (SELECT COALESCE(SUM(p.amount), 0) FROM payments p
                JOIN sales s ON s.id = p."saleId"
                JOIN payment_methods pm ON pm.id = p."paymentMethodId"
              WHERE ${LATE_SALE_OF_SHIFT} AND ${PAID} AND pm."methodType" = 'cash' AND p."tenderedCurrency" IS NULL)
             - (SELECT COALESCE(SUM(s."changeAmount"), 0) FROM sales s
                WHERE ${LATE_SALE_OF_SHIFT}
                  AND (s.metadata->'changeTender' IS NULL OR jsonb_typeof(s.metadata->'changeTender') = 'null')) AS "lateCash",
             sh.status
      FROM shifts sh
      JOIN registers rg ON rg.id = sh."registerId"
      JOIN users u ON u.id = sh."openedById"
      WHERE sh."tenantId" = $1 AND sh."openedAt" >= $2 AND sh."openedAt" <= $3 AND ${shiftInBranch(B)}
      ORDER BY sh."openedAt" DESC`,
  },
  {
    key: 'sales-by-hour',
    title: 'Sales by hour',
    description:
      'Sales per weekday and hour of the day (store time zone), per currency: when the store is busy.',
    group: 'Sales',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'weekday', label: 'Weekday (1 = Monday)', type: 'number' },
      { key: 'hour', label: 'Hour', type: 'number' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'saleCount', label: 'Sales', type: 'number', total: true },
      {
        key: 'netSales',
        label: 'Sales (excl. tax)',
        type: 'money',
        total: true,
      },
      {
        key: 'averageSale',
        label: 'Average sale (excl. tax)',
        type: 'money',
      },
    ],
    sql: `
      WITH sold AS (
        SELECT s.id, TRIM(s."currencyCode") AS currency,
               EXTRACT(ISODOW FROM s."saleDate" AT TIME ZONE $4)::int AS weekday,
               EXTRACT(HOUR FROM s."saleDate" AT TIME ZONE $4)::int AS hour,
               COALESCE(SUM(${LINE_NET_EX_TAX}), 0) AS net
        FROM sales s JOIN sale_items i ON i."saleId" = s.id AND ${REVENUE_LINE}
        WHERE ${IN_PERIOD} AND ${SOLD} GROUP BY s.id
      )
      SELECT weekday, hour, currency, COUNT(*) AS "saleCount", SUM(net) AS "netSales",
             SUM(net) / NULLIF(COUNT(*), 0) AS "averageSale"
      FROM sold GROUP BY 1, 2, 3
      ORDER BY currency, weekday, hour`,
  },
  {
    key: 'sales-by-salesperson',
    title: 'Sales by salesperson',
    description:
      'Sales credited to each salesperson (not the cashier), less the returns of those sales, per currency (excl. tax).',
    group: 'Sales',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'salesperson', label: 'Salesperson', type: 'text' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'saleCount', label: 'Sales', type: 'number', total: true },
      { key: 'items', label: 'Items sold', type: 'number', total: true },
      {
        key: 'sales',
        label: 'Sales (excl. tax)',
        type: 'money',
        total: true,
      },
      {
        key: 'discounts',
        label: 'Discounts given (excl. tax)',
        type: 'money',
        total: true,
      },
      {
        key: 'returns',
        label: 'Returns (excl. tax)',
        type: 'money',
        total: true,
      },
      {
        key: 'netSales',
        label: 'Net sales (excl. tax)',
        type: 'money',
        total: true,
      },
      {
        key: 'averageSale',
        label: 'Average sale (excl. tax)',
        type: 'money',
      },
    ],
    sql: `
      WITH sold AS (
        SELECT s."salespersonId" AS id, TRIM(s."currencyCode") AS currency, COUNT(DISTINCT i."saleId") AS "saleCount",
               COALESCE(SUM(i.quantity), 0) AS items, COALESCE(SUM(${LINE_NET_EX_TAX}), 0) AS net,
               COALESCE(SUM(${LINE_GROSS_EX_TAX} - ${LINE_NET_EX_TAX}), 0) AS discounts
        FROM sales s LEFT JOIN sale_items i ON i."saleId" = s.id AND ${REVENUE_LINE}
        WHERE ${IN_PERIOD} AND ${SOLD} AND s."salespersonId" IS NOT NULL GROUP BY 1, 2
      ), returned AS (
        SELECT s."salespersonId" AS id, TRIM(r."currencyCode") AS currency, SUM(r.total - r."taxAmount") AS net
        FROM sale_returns r JOIN sales s ON s.id = r."originalSaleId"
        WHERE ${RETURNS_IN_PERIOD} AND s."salespersonId" IS NOT NULL GROUP BY 1, 2
      ), people AS (
        SELECT id, currency FROM sold UNION SELECT id, currency FROM returned
      )
      SELECT ${PERSON('u')} AS salesperson, people.currency,
             COALESCE(sold."saleCount", 0) AS "saleCount", COALESCE(sold.items, 0) AS items,
             COALESCE(sold.net, 0) AS sales, COALESCE(sold.discounts, 0) AS discounts,
             COALESCE(returned.net, 0) AS returns,
             COALESCE(sold.net, 0) - COALESCE(returned.net, 0) AS "netSales",
             sold.net / NULLIF(sold."saleCount", 0) AS "averageSale"
      FROM people
      JOIN users u ON u.id = people.id
      LEFT JOIN sold ON sold.id = people.id AND sold.currency = people.currency
      LEFT JOIN returned ON returned.id = people.id AND returned.currency = people.currency
      ORDER BY people.currency, "netSales" DESC`,
  },
  {
    key: 'stock-card',
    title: 'Stock card',
    description:
      'Every stock movement of one item in the period: opening balance, each movement with the running balance, closing balance.',
    group: 'Inventory',
    usesDateRange: true,
    branchFilter: true,
    parameters: [
      { key: 'variantId', label: 'Item', required: true },
      { key: 'locationId', label: 'Location', required: false },
    ],
    columns: [
      { key: 'date', label: 'Date', type: 'datetime' },
      { key: 'entry', label: 'Movement', type: 'text', translate: true },
      { key: 'reference', label: 'Reference', type: 'text' },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'quantityIn', label: 'In', type: 'number' },
      { key: 'quantityOut', label: 'Out', type: 'number' },
      { key: 'balance', label: 'Balance', type: 'number' },
      {
        key: 'unitCost',
        label: 'Unit cost',
        type: 'money',
        requires: 'inventory.cost.view',
      },
      { key: 'user', label: 'By', type: 'text' },
    ],
    // A movement is either inbound (toLocationId) or outbound (fromLocationId);
    // only the legs at the chosen location / branches count
    sql: `
      WITH mv AS (
        SELECT m.id, m."movementDate" AS date, m.created_at, m."movementType"::text AS entry,
               COALESCE(m."referenceNumber", m."referenceType") AS reference,
               loc.name AS location, m.cost, ${PERSON('u')} AS "user",
               CASE WHEN m."toLocationId" IS NOT NULL AND ($7::uuid IS NULL OR m."toLocationId" = $7::uuid)
                         AND ${locationInBranch(B, 'm."toLocationId"')} THEN m.quantity ELSE 0 END AS qin,
               CASE WHEN m."fromLocationId" IS NOT NULL AND ($7::uuid IS NULL OR m."fromLocationId" = $7::uuid)
                         AND ${locationInBranch(B, 'm."fromLocationId"')} THEN m.quantity ELSE 0 END AS qout,
               COALESCE(m."toLocationId", m."fromLocationId") AS "locationId"
        FROM stock_movements m
        LEFT JOIN inventory_locations loc ON loc.id = COALESCE(m."toLocationId", m."fromLocationId")
        LEFT JOIN users u ON u.id = m."userId"
        WHERE m."tenantId" = $1 AND m."variantId" = $6::uuid AND m."movementDate" <= $3
      ), relevant AS (
        SELECT * FROM mv
        WHERE qin <> 0 OR qout <> 0
           OR (entry = 'revaluation' AND ($7::uuid IS NULL OR "locationId" = $7::uuid)
               AND ${locationInBranch(B, '"locationId"')})
      ), opening AS (
        SELECT COALESCE(SUM(qin - qout), 0) AS qty FROM relevant WHERE date < $2
      ), period AS (
        SELECT relevant.*, (SELECT qty FROM opening)
                 + SUM(qin - qout) OVER (ORDER BY date, created_at, id) AS balance
        FROM relevant WHERE date >= $2
      )
      SELECT date, entry, reference, location, "quantityIn", "quantityOut", balance, "unitCost", "user"
      FROM (
        SELECT 0 AS seq, $2::timestamptz AS date, NULL::timestamptz AS created_at, 'Opening balance' AS entry,
               NULL::text AS reference, NULL::text AS location, NULL::numeric AS "quantityIn",
               NULL::numeric AS "quantityOut", (SELECT qty FROM opening)::numeric AS balance,
               NULL::numeric AS "unitCost", NULL::text AS "user"
        UNION ALL
        SELECT 1, date, created_at, entry, reference, location, NULLIF(qin, 0), NULLIF(qout, 0),
               balance, cost, "user" FROM period
        UNION ALL
        SELECT 2, $3::timestamptz, NULL, 'Closing balance', NULL, NULL, NULL, NULL,
               (SELECT qty FROM opening) + COALESCE((SELECT SUM(qin - qout) FROM period), 0), NULL, NULL
      ) card
      ORDER BY seq, date, created_at`,
  },
  {
    key: 'stock-adjustments',
    title: 'Stock counts & adjustments',
    description:
      'Count variances and manual adjustments in the period: quantities, value, reasons, who did them and who approved.',
    group: 'Inventory',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'date', label: 'Date', type: 'datetime' },
      { key: 'document', label: 'Document', type: 'text' },
      { key: 'kind', label: 'Type', type: 'text', translate: true },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'sku', label: 'SKU', type: 'text' },
      { key: 'product', label: 'Product', type: 'text' },
      { key: 'expected', label: 'Expected', type: 'number' },
      { key: 'counted', label: 'Counted', type: 'number' },
      { key: 'variance', label: 'Variance', type: 'number', total: true },
      {
        key: 'value',
        label: 'Variance value (cost)',
        type: 'money',
        total: true,
        requires: 'inventory.cost.view',
      },
      { key: 'reason', label: 'Reason', type: 'text', translate: true },
      { key: 'by', label: 'By', type: 'text' },
      { key: 'approvedBy', label: 'Approved by', type: 'text' },
      { key: 'status', label: 'Status', type: 'text', translate: true },
    ],
    sql: `
      SELECT * FROM (
        SELECT COALESCE(c."postedAt", c."submittedAt", c.created_at) AS date, c."countNumber" AS document,
               'count' AS kind, loc.name AS location, v.sku, p.name->>'en' AS product,
               ci."expectedQuantity"::numeric AS expected, ci."countedQuantity"::numeric AS counted,
               ci.variance::numeric AS variance,
               ci.variance * COALESCE(ci."unitCost", v.cost, 0) AS value,
               ci.reason::text AS reason, ${PERSON('cu')} AS "by", ${PERSON('au')} AS "approvedBy",
               c.status::text AS status
        FROM stock_count_items ci
        JOIN stock_counts c ON c.id = ci."countId"
        JOIN product_variants v ON v.id = ci."variantId"
        JOIN products p ON p.id = v."productId"
        LEFT JOIN inventory_locations loc ON loc.id = c."locationId"
        LEFT JOIN users cu ON cu.id = COALESCE(c."submittedById", c."createdById")
        LEFT JOIN users au ON au.id = c."approvedById"
        WHERE c."tenantId" = $1 AND c.status::text IN ('pending_approval', 'posted')
          AND COALESCE(ci.variance, 0) <> 0
          AND COALESCE(c."postedAt", c."submittedAt", c.created_at) >= $2
          AND COALESCE(c."postedAt", c."submittedAt", c.created_at) <= $3
          AND ${locationInBranch(B, 'c."locationId"')}
        UNION ALL
        SELECT m."movementDate", sa."adjustmentNumber", 'adjustment', loc.name, v.sku, p.name->>'en',
               NULL, NULL,
               CASE WHEN m."toLocationId" IS NOT NULL THEN m.quantity ELSE -m.quantity END,
               CASE WHEN m."toLocationId" IS NOT NULL THEN m.quantity ELSE -m.quantity END * COALESCE(m.cost, 0),
               sa.reason::text, ${PERSON('mu')},
               (SELECT ${PERSON('xu')} FROM audit_logs a JOIN users xu ON xu.id = a."approverId"
                 WHERE a."tenantId" = $1 AND a."entityType" = 'stock_adjustment' AND a."entityId" = sa.id::text
                 LIMIT 1),
               sa.status::text
        FROM stock_movements m
        JOIN stock_adjustments sa ON sa.id = m."referenceId" AND sa."tenantId" = m."tenantId"
        JOIN product_variants v ON v.id = m."variantId"
        JOIN products p ON p.id = v."productId"
        LEFT JOIN inventory_locations loc ON loc.id = sa."locationId"
        LEFT JOIN users mu ON mu.id = sa."userId"
        WHERE m."tenantId" = $1 AND m."referenceType" = 'adjustment'
          AND m."movementDate" >= $2 AND m."movementDate" <= $3
          AND ${locationInBranch(B, 'sa."locationId"')}
      ) changes
      ORDER BY date DESC`,
  },
  {
    key: 'transfers',
    title: 'Stock transfers',
    description:
      'Transfers created in the period and every transfer still open: shipped, received, damaged, missing and still in transit.',
    group: 'Inventory',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'transferNumber', label: 'Transfer', type: 'text' },
      { key: 'status', label: 'Status', type: 'text', translate: true },
      { key: 'fromLocation', label: 'From', type: 'text' },
      { key: 'toLocation', label: 'To', type: 'text' },
      { key: 'createdAt', label: 'Created', type: 'datetime' },
      { key: 'dispatchedAt', label: 'Shipped', type: 'datetime' },
      { key: 'receivedAt', label: 'Received', type: 'datetime' },
      { key: 'requested', label: 'Requested', type: 'number', total: true },
      { key: 'shipped', label: 'Units shipped', type: 'number', total: true },
      { key: 'received', label: 'Units received', type: 'number', total: true },
      { key: 'damaged', label: 'Damaged', type: 'number', total: true },
      { key: 'missing', label: 'Missing', type: 'number', total: true },
      { key: 'inTransit', label: 'In transit', type: 'number', total: true },
      {
        key: 'inTransitValue',
        label: 'In transit value (cost)',
        type: 'money',
        total: true,
        requires: 'inventory.cost.view',
      },
    ],
    // In transit = shipped − received − damaged − written off − returned (see transfer.logic.ts)
    sql: `
      SELECT t."transferNumber", t.status::text AS status, fl.name AS "fromLocation", tl.name AS "toLocation",
             t.created_at AS "createdAt", t."dispatchedAt", t."receivedAt",
             SUM(ti."quantityRequested") AS requested, SUM(ti."quantityDispatched") AS shipped,
             SUM(ti."quantityReceived") AS received, SUM(COALESCE(ti."quantityDamaged", 0)) AS damaged,
             SUM(COALESCE(ti."quantityMissing", 0)) AS missing,
             SUM(${TRANSIT}) AS "inTransit",
             SUM(${TRANSIT} * COALESCE(ti."unitCost", 0)) AS "inTransitValue"
      FROM stock_transfers t
      JOIN stock_transfer_items ti ON ti."transferId" = t.id
      LEFT JOIN inventory_locations fl ON fl.id = t."fromLocationId"
      LEFT JOIN inventory_locations tl ON tl.id = t."toLocationId"
      WHERE t."tenantId" = $1
        AND ((t.created_at >= $2 AND t.created_at <= $3)
             OR t.status::text IN ('partially_dispatched', 'in_transit', 'partially_received'))
        AND (${locationInBranch(B, 't."fromLocationId"')} OR ${locationInBranch(B, 't."toLocationId"')})
      GROUP BY t.id, fl.name, tl.name
      ORDER BY t.created_at DESC`,
  },
  {
    key: 'purchasing',
    title: 'Purchasing',
    description:
      'Purchase orders in the period: ordered, received, still outstanding, invoiced by the supplier (vs. received) and paid, per order currency.',
    group: 'Purchasing',
    usesDateRange: true,
    branchFilter: true,
    requires: ['purchasing.manage', 'purchasing.payables'],
    columns: [
      { key: 'poNumber', label: 'Purchase order', type: 'text' },
      { key: 'supplier', label: 'Supplier', type: 'text' },
      { key: 'status', label: 'Status', type: 'text', translate: true },
      { key: 'orderDate', label: 'Ordered', type: 'datetime' },
      { key: 'location', label: 'Location', type: 'text' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'ordered', label: 'Ordered value', type: 'money', total: true },
      { key: 'received', label: 'Received value', type: 'money', total: true },
      { key: 'outstanding', label: 'Outstanding', type: 'money', total: true },
      { key: 'invoiced', label: 'Invoiced', type: 'money', total: true },
      {
        key: 'invoicedVsReceived',
        label: 'Invoiced − received',
        type: 'money',
        total: true,
      },
      { key: 'paid', label: 'Paid', type: 'money', total: true },
    ],
    sql: `
      SELECT po.*, po.invoiced - po.received AS "invoicedVsReceived" FROM (
        SELECT o."poNumber", sp.name AS supplier, o.status::text AS status, o."orderDate",
               loc.name AS location, TRIM(o."currencyCode") AS currency, o.total AS ordered,
               COALESCE((SELECT SUM(gr."totalCost") FROM goods_receipts gr WHERE gr."purchaseOrderId" = o.id), 0) AS received,
               CASE WHEN o.status::text IN ('draft', 'cancelled', 'closed') THEN 0 ELSE COALESCE((
                 SELECT SUM(GREATEST(poi."quantityOrdered" - poi."quantityReceived" - COALESCE(poi."quantityCancelled", 0), 0)
                            * poi.total / NULLIF(poi."quantityOrdered", 0))
                 FROM purchase_order_items poi WHERE poi."purchaseOrderId" = o.id), 0) END AS outstanding,
               COALESCE((SELECT SUM(si.total) FROM supplier_invoices si
                         WHERE si."purchaseOrderId" = o.id AND si.status <> 'void'), 0) AS invoiced,
               COALESCE((SELECT SUM(a.amount) FROM supplier_allocations a
                         JOIN supplier_invoices si ON si.id = a."invoiceId"
                         LEFT JOIN supplier_payments spay ON spay.id = a."paymentId"
                         LEFT JOIN supplier_credits scr ON scr.id = a."creditId"
                         WHERE si."purchaseOrderId" = o.id AND si.status <> 'void'
                           AND (spay.status = 'posted' OR scr.status = 'open')), 0) AS paid
        FROM purchase_orders o
        JOIN suppliers sp ON sp.id = o."supplierId"
        LEFT JOIN inventory_locations loc ON loc.id = o."locationId"
        WHERE o."tenantId" = $1 AND o."orderDate" >= $2 AND o."orderDate" <= $3
          AND ${locationInBranch(B, 'o."locationId"')}
      ) po
      ORDER BY po."orderDate" DESC`,
  },
  {
    key: 'supplier-aging',
    title: 'Supplier aging',
    description:
      'What is owed to each supplier today, by how overdue it is, less unapplied payments and credits (same rules as Payables).',
    group: 'Purchasing',
    usesDateRange: false,
    branchFilter: false,
    requires: ['purchasing.payables', 'purchasing.manage'],
    columns: [
      { key: 'code', label: 'Code', type: 'text' },
      { key: 'supplier', label: 'Supplier', type: 'text' },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'current', label: 'Not yet due', type: 'money', total: true },
      { key: 'days1to30', label: '1–30 days', type: 'money', total: true },
      { key: 'days31to60', label: '31–60 days', type: 'money', total: true },
      { key: 'days61to90', label: '61–90 days', type: 'money', total: true },
      { key: 'over90', label: 'Over 90 days', type: 'money', total: true },
      { key: 'unapplied', label: 'Unapplied', type: 'money', total: true },
      { key: 'balance', label: 'Balance', type: 'money', total: true },
    ],
    sql: `
      ${supplierAgingCte('$4')}
      SELECT code, supplier, currency, current, "days1to30", "days31to60", "days61to90", over90, unapplied, balance
      FROM aging
      ORDER BY currency, balance DESC`,
  },
  {
    key: 'expenses',
    title: 'Expenses',
    description:
      'Expenses dated in the period by category, branch, payee and status, per currency.',
    group: 'Expenses',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'category', label: 'Category', type: 'text' },
      { key: 'branch', label: 'Branch', type: 'text' },
      { key: 'payee', label: 'Payee', type: 'text' },
      { key: 'status', label: 'Status', type: 'text', translate: true },
      { key: 'currency', label: 'Currency', type: 'text' },
      { key: 'count', label: 'Expenses', type: 'number', total: true },
      { key: 'amount', label: 'Amount', type: 'money', total: true },
    ],
    sql: `
      SELECT ec.name AS category, b.name AS branch, e.payee, e.status::text AS status,
             TRIM(e."currencyCode") AS currency, COUNT(*) AS count, SUM(e.amount) AS amount
      FROM expenses e
      LEFT JOIN expense_categories ec ON ec.id = e."categoryId"
      LEFT JOIN registers rg ON rg.id = COALESCE(e."registerId", (SELECT es."registerId" FROM shifts es WHERE es.id = e."shiftId"))
      LEFT JOIN branches b ON b.id = rg."branchId"
      WHERE e."tenantId" = $1
        AND e."expenseDate" >= ($2::timestamptz AT TIME ZONE $4)::date
        AND e."expenseDate" <= ($3::timestamptz AT TIME ZONE $4)::date
        AND ${expenseInBranch(B)}
      GROUP BY 1, 2, 3, 4, 5
      ORDER BY currency, amount DESC`,
  },
  {
    key: 'loyalty',
    title: 'Loyalty points',
    description:
      'Points earned, redeemed, reversed and adjusted in the period and their value; the outstanding balance (liability) of all customers today.',
    group: 'Customers',
    usesDateRange: true,
    branchFilter: true,
    columns: [
      { key: 'entry', label: 'Entry', type: 'text', translate: true },
      { key: 'customers', label: 'Customers', type: 'number' },
      { key: 'transactions', label: 'Transactions', type: 'number' },
      { key: 'points', label: 'Points', type: 'number' },
      { key: 'value', label: 'Value', type: 'money' },
      { key: 'currency', label: 'Currency', type: 'text' },
    ],
    // Points are valued at the store's point value, in the store currency. The
    // liability is store-wide, so it is only shown without a branch filter
    sql: `
      WITH cfg AS (
        SELECT COALESCE((t.settings->>'loyaltyPointValue')::numeric, 0.01) AS "pointValue",
               COALESCE(t.settings->>'currencyCode', 'USD') AS currency
        FROM tenants t WHERE t.id = $1
      ), ledger AS (
        SELECT lt.type::text AS entry, COUNT(DISTINCT lt."customerId") AS customers,
               COUNT(*) AS transactions, SUM(lt.points) AS points
        FROM loyalty_transactions lt
        LEFT JOIN sales s ON s.id = lt."saleId"
        LEFT JOIN sale_returns r ON r.id = lt."returnId"
        WHERE lt."tenantId" = $1 AND lt.created_at >= $2 AND lt.created_at <= $3
          AND (${B}::uuid[] IS NULL OR s."branchId" = ANY(${B}::uuid[])
               OR (r.id IS NOT NULL AND ${registerInBranch(B, 'r."registerId"')}))
        GROUP BY 1
      )
      SELECT entry, customers, transactions, points, points * cfg."pointValue" AS value, cfg.currency
      FROM ledger, cfg
      UNION ALL
      SELECT 'Outstanding balance (liability)', COUNT(*), NULL, SUM(c."loyaltyPoints"),
             SUM(c."loyaltyPoints") * cfg."pointValue", cfg.currency
      FROM customers c, cfg
      WHERE c."tenantId" = $1 AND c."loyaltyPoints" > 0 AND ${B}::uuid[] IS NULL
      GROUP BY cfg."pointValue", cfg.currency`,
  },
  {
    key: 'audit-activity',
    title: 'Audit activity',
    description:
      'Actions recorded in the audit trail in the period, per action and user, with how many needed a manager approval.',
    group: 'Administration',
    usesDateRange: true,
    branchFilter: false,
    requires: ['audit.view'],
    columns: [
      { key: 'action', label: 'Action', type: 'text' },
      { key: 'user', label: 'User', type: 'text' },
      { key: 'count', label: 'Times', type: 'number', total: true },
      { key: 'approved', label: 'With approval', type: 'number', total: true },
      { key: 'first', label: 'First', type: 'datetime' },
      { key: 'last', label: 'Last', type: 'datetime' },
    ],
    sql: `
      SELECT a.action, COALESCE(${PERSON('u')}, 'System') AS "user", COUNT(*) AS count,
             COUNT(*) FILTER (WHERE a."approverId" IS NOT NULL) AS approved,
             MIN(a.created_at) AS first, MAX(a.created_at) AS last
      FROM audit_logs a LEFT JOIN users u ON u.id = a."actorId"
      WHERE a."tenantId" = $1 AND a.created_at >= $2 AND a.created_at <= $3
      GROUP BY 1, 2
      ORDER BY count DESC, 1`,
  },
];

// Text form of a raw query value (dates as ISO, objects as JSON)
export function asText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'function' || typeof value === 'symbol') return '';
  return `${value as string | number | boolean | bigint}`;
}

export const findReport = (key: string) => REPORTS.find((r) => r.key === key);
