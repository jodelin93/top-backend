import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Permission } from '../auth/permissions';
import { ReportQueryDto } from './reports.dto';
import { asText, LATE_SALE_OF_SHIFT } from './report-definitions';
import {
  bindParams,
  branchFilter,
  returnInBranch,
  saleInBranch,
  shiftInBranch,
  type ReportScope,
} from './report-sql';

type Row = Record<string, unknown>;

interface CheckDefinition {
  key: string;
  label: string;
  description: string;
  // Returns offending rows; $1 tenant, $2 from, $3 to, $4 branch ids (uuid[] or
  // NULL; only those it uses are bound)
  sql: string;
  // Not tied to a branch: skipped when the reconciliation is limited to branches
  storeWide?: boolean;
  // Lists balances (as expected/actual): only for users holding this permission
  requires?: Permission;
}

const SOLD = `s.status IN ('completed', 'partially_refunded', 'refunded')`;
const PAID = `p.status IN ('completed', 'captured', 'refunded')`;
const IN_PERIOD = `s."tenantId" = $1 AND s."saleDate" >= $2 AND s."saleDate" <= $3 AND ${saleInBranch('$4')}`;
const RETURNS_IN_PERIOD = `r."tenantId" = $1 AND r.created_at >= $2 AND r.created_at <= $3 AND ${returnInBranch('$4')}`;
// Money is stored with 4 decimals but settled in cents
const TOLERANCE = 0.005;

/**
 * Sales reconciliation (R123): every figure on the dashboard must trace back to source
 * records. Each check lists the records that don't add up.
 */
const CHECKS: CheckDefinition[] = [
  {
    key: 'sale-lines',
    label: 'Sale totals match their lines',
    description:
      'Subtotal, discounts, tax and total of each sale equal the sum of its lines.',
    sql: `
      SELECT s."saleNumber" AS reference, s.total AS expected, SUM(i.total) AS actual,
             'lines subtotal ' || SUM(i.subtotal) || ' / discount ' || SUM(i."discountAmount") || ' / tax ' || SUM(i."taxAmount") AS detail
      FROM sales s JOIN sale_items i ON i."saleId" = s.id
      WHERE ${IN_PERIOD} AND ${SOLD}
      GROUP BY s.id
      HAVING ABS(SUM(i.total) - s.total) > ${TOLERANCE}
          OR ABS(SUM(i.subtotal) - s.subtotal) > ${TOLERANCE}
          OR ABS(SUM(i."discountAmount") - s."discountAmount") > ${TOLERANCE}
          OR ABS(SUM(i."taxAmount") - s."taxAmount") > ${TOLERANCE}
      LIMIT 100`,
  },
  {
    key: 'sale-payments',
    label: 'Payments cover each sale',
    description:
      "Money taken (minus change given) equals each completed sale's total.",
    sql: `
      SELECT s."saleNumber" AS reference, s.total AS expected,
             COALESCE(SUM(p.amount) FILTER (WHERE ${PAID}), 0) - s."changeAmount" AS actual,
             'paid ' || COALESCE(SUM(p.amount) FILTER (WHERE ${PAID}), 0) || ', change ' || s."changeAmount" AS detail
      FROM sales s LEFT JOIN payments p ON p."saleId" = s.id
      WHERE ${IN_PERIOD} AND ${SOLD}
      GROUP BY s.id
      HAVING ABS(COALESCE(SUM(p.amount) FILTER (WHERE ${PAID}), 0) - s."changeAmount" - s.total) > ${TOLERANCE}
      LIMIT 100`,
  },
  {
    key: 'sale-stock',
    label: 'Every sale moved stock',
    description:
      'Each sold item has a matching stock movement in the inventory ledger.',
    sql: `
      SELECT s."saleNumber" AS reference, SUM(i.quantity) AS expected,
             COALESCE((SELECT SUM(m.quantity) FROM stock_movements m
                       WHERE m."referenceType" = 'sale' AND m."referenceId" = s.id AND m."movementType" = 'sale'), 0) AS actual,
             'units sold vs units moved' AS detail
      FROM sales s JOIN sale_items i ON i."saleId" = s.id
      WHERE ${IN_PERIOD} AND ${SOLD}
      GROUP BY s.id
      HAVING SUM(i.quantity) <> COALESCE((SELECT SUM(m.quantity) FROM stock_movements m
                       WHERE m."referenceType" = 'sale' AND m."referenceId" = s.id AND m."movementType" = 'sale'), 0)
      LIMIT 100`,
  },
  {
    key: 'return-lines',
    label: 'Return totals match their lines',
    description: "Each return's total equals the sum of its returned lines.",
    sql: `
      SELECT r."returnNumber" AS reference, r.total AS expected, SUM(ri.total) AS actual, NULL AS detail
      FROM sale_returns r JOIN sale_return_items ri ON ri."returnId" = r.id
      WHERE ${RETURNS_IN_PERIOD}
      GROUP BY r.id HAVING ABS(SUM(ri.total) - r.total) > ${TOLERANCE}
      LIMIT 100`,
  },
  {
    key: 'return-refunds',
    label: 'Refunds paid match each return',
    description:
      "Money given back (excluding failed card refunds) equals each return's total.",
    sql: `
      SELECT r."returnNumber" AS reference, r.total AS expected,
             COALESCE(SUM(rf.amount) FILTER (WHERE rf.status <> 'failed'), 0) AS actual,
             r.status::text AS detail
      FROM sale_returns r LEFT JOIN sale_return_refunds rf ON rf."returnId" = r.id
      WHERE ${RETURNS_IN_PERIOD}
      GROUP BY r.id
      HAVING ABS(COALESCE(SUM(rf.amount) FILTER (WHERE rf.status <> 'failed'), 0) - r.total) > ${TOLERANCE}
      LIMIT 100`,
  },
  {
    key: 'over-refunded',
    label: 'No sale refunded more than was paid',
    description:
      "The returns of a sale never add up to more than the sale's total.",
    sql: `
      SELECT s."saleNumber" AS reference, s.total AS expected, SUM(r.total) AS actual, COUNT(*) || ' return(s)' AS detail
      FROM sales s JOIN sale_returns r ON r."originalSaleId" = s.id
      WHERE ${IN_PERIOD}
      GROUP BY s.id HAVING SUM(r.total) - s.total > ${TOLERANCE}
      LIMIT 100`,
  },
  {
    key: 'refund-status',
    label: 'Sale status reflects its returns',
    description:
      'Fully returned sales are "refunded" and partly returned ones "partially refunded".',
    sql: `
      SELECT s."saleNumber" AS reference, SUM(i.quantity) AS expected,
             COALESCE((SELECT SUM(ri.quantity) FROM sale_return_items ri JOIN sale_returns r ON r.id = ri."returnId"
                       WHERE r."originalSaleId" = s.id), 0) AS actual,
             'status ' || s.status AS detail
      FROM sales s JOIN sale_items i ON i."saleId" = s.id
      WHERE ${IN_PERIOD} AND ${SOLD}
      GROUP BY s.id
      HAVING (s.status = 'completed' AND COALESCE((SELECT SUM(ri.quantity) FROM sale_return_items ri JOIN sale_returns r ON r.id = ri."returnId" WHERE r."originalSaleId" = s.id), 0) > 0)
          OR (s.status = 'refunded' AND COALESCE((SELECT SUM(ri.quantity) FROM sale_return_items ri JOIN sale_returns r ON r.id = ri."returnId" WHERE r."originalSaleId" = s.id), 0) < SUM(i.quantity))
          OR (s.status = 'partially_refunded' AND COALESCE((SELECT SUM(ri.quantity) FROM sale_return_items ri JOIN sale_returns r ON r.id = ri."returnId" WHERE r."originalSaleId" = s.id), 0) IN (0, SUM(i.quantity)))
      LIMIT 100`,
  },
  {
    key: 'shift-late-sales',
    label: 'No sales uploaded after their shift closed',
    description:
      "Sales filed under a shift after it closed (e.g. offline sales uploaded late) are not in its frozen cash count and need a manager's review.",
    sql: `
      SELECT sh."shiftNumber" AS reference, 0 AS expected, COUNT(s.id) AS actual,
             'sales total ' || SUM(s.total) || ' ' || MAX(TRIM(s."currencyCode")) || ', last uploaded ' || TO_CHAR(MAX(s.created_at), 'YYYY-MM-DD HH24:MI') AS detail
      FROM shifts sh JOIN sales s ON ${LATE_SALE_OF_SHIFT}
      WHERE sh."tenantId" = $1 AND sh."openedAt" >= $2 AND sh."openedAt" <= $3 AND ${shiftInBranch('$4')}
      GROUP BY sh.id
      LIMIT 100`,
  },
  {
    key: 'loyalty-ledger',
    label: 'Loyalty balances match their ledger',
    description:
      "Each customer's points balance equals the sum of their loyalty transactions (all time).",
    storeWide: true,
    sql: `
      SELECT COALESCE(NULLIF(CONCAT_WS(' ', c."firstName", c."lastName"), ''), c.email, c.id::text) AS reference,
             COALESCE(l.points, 0) AS expected, c."loyaltyPoints" AS actual,
             COALESCE(l.entries, 0) || ' ledger entries' AS detail
      FROM customers c
      LEFT JOIN (
        SELECT "customerId", SUM(points) AS points, COUNT(*) AS entries
        FROM loyalty_transactions WHERE "tenantId" = $1 GROUP BY 1
      ) l ON l."customerId" = c.id
      WHERE c."tenantId" = $1 AND c."loyaltyPoints" <> COALESCE(l.points, 0)
      LIMIT 100`,
  },
  // Same sum as CustomerCreditService.ledgerBalance, for every customer at once
  {
    key: 'customer-credit-ledger',
    label: 'Account balances match their ledger',
    description:
      "Each customer's balance owed on account equals the sum of their account ledger entries (all time).",
    storeWide: true,
    requires: 'customers.finance.view',
    sql: `
      SELECT COALESCE(NULLIF(CONCAT_WS(' ', c."firstName", c."lastName"), ''), c."companyName", c.email, c.id::text) AS reference,
             COALESCE(l.amount, 0) AS expected, c."currentBalance" AS actual,
             COALESCE(l.entries, 0) || ' ledger entries' AS detail
      FROM customers c
      LEFT JOIN (
        SELECT "customerId", SUM(amount) AS amount, COUNT(*) AS entries
        FROM customer_credit_entries WHERE "tenantId" = $1 GROUP BY 1
      ) l ON l."customerId" = c.id
      WHERE c."tenantId" = $1 AND ABS(c."currentBalance" - COALESCE(l.amount, 0)) > ${TOLERANCE}
      LIMIT 100`,
  },
  {
    key: 'stored-value-ledger',
    label: 'Gift card and store credit balances match their entries',
    description:
      'Each gift card / store credit balance equals the sum of its movements (issue, redemptions, refunds, reversals, adjustments, expiry).',
    storeWide: true,
    // Same permission as the stored-value account list (GET /stored-value)
    requires: 'customers.finance.view',
    sql: `
      SELECT a."accountType"::text || ' ' || COALESCE('****' || a.last4, a.id::text) AS reference,
             COALESCE(e.amount, 0) AS expected, a.balance AS actual,
             COALESCE(e.entries, 0) || ' entries, ' || TRIM(a."currencyCode") || ', ' || a.status::text AS detail
      FROM stored_value_accounts a
      LEFT JOIN (
        SELECT "accountId", SUM(amount) AS amount, COUNT(*) AS entries
        FROM stored_value_entries WHERE "tenantId" = $1 GROUP BY 1
      ) e ON e."accountId" = a.id
      WHERE a."tenantId" = $1 AND ABS(a.balance - COALESCE(e.amount, 0)) > ${TOLERANCE}
      LIMIT 100`,
  },
];

interface CurrencyTotalsRow {
  currencyCode: string;
  saleCount: string | number;
  salesTotal: string | number;
  linesTotal: string | number;
  paymentsNet: string | number;
  returnsTotal: string | number;
  refundsPaid: string | number;
}

/**
 * Control totals per currency: payments and refunds are in their sale's /
 * return's currency, so amounts in different currencies are never added.
 */
const TOTALS_BY_CURRENCY = `
  WITH sold AS (
    SELECT TRIM(s."currencyCode") AS c, COUNT(*) AS n, SUM(s.total) AS total, SUM(s."changeAmount") AS change
    FROM sales s WHERE ${IN_PERIOD} AND ${SOLD} GROUP BY 1
  ), lines AS (
    SELECT TRIM(s."currencyCode") AS c, SUM(i.total) AS total
    FROM sale_items i JOIN sales s ON s.id = i."saleId" WHERE ${IN_PERIOD} AND ${SOLD} GROUP BY 1
  ), paid AS (
    SELECT TRIM(s."currencyCode") AS c, SUM(p.amount) AS total
    FROM payments p JOIN sales s ON s.id = p."saleId" WHERE ${IN_PERIOD} AND ${SOLD} AND ${PAID} GROUP BY 1
  ), rets AS (
    SELECT TRIM(r."currencyCode") AS c, SUM(r.total) AS total FROM sale_returns r WHERE ${RETURNS_IN_PERIOD} GROUP BY 1
  ), refunds AS (
    SELECT TRIM(r."currencyCode") AS c, SUM(rf.amount) AS total
    FROM sale_return_refunds rf JOIN sale_returns r ON r.id = rf."returnId"
    WHERE ${RETURNS_IN_PERIOD} AND rf.status <> 'failed' GROUP BY 1
  ), keys AS (
    SELECT c FROM sold UNION SELECT c FROM paid UNION SELECT c FROM rets UNION SELECT c FROM refunds
  )
  SELECT keys.c AS "currencyCode", COALESCE(sold.n, 0) AS "saleCount",
         COALESCE(sold.total, 0) AS "salesTotal", COALESCE(lines.total, 0) AS "linesTotal",
         COALESCE(paid.total, 0) - COALESCE(sold.change, 0) AS "paymentsNet",
         COALESCE(rets.total, 0) AS "returnsTotal", COALESCE(refunds.total, 0) AS "refundsPaid"
  FROM keys
  LEFT JOIN sold ON sold.c = keys.c LEFT JOIN lines ON lines.c = keys.c
  LEFT JOIN paid ON paid.c = keys.c LEFT JOIN rets ON rets.c = keys.c
  LEFT JOIN refunds ON refunds.c = keys.c
  ORDER BY 1`;

@Injectable()
export class ReconciliationReportService {
  constructor(private dataSource: DataSource) {}

  /**
   * `permissions`: the user's; checks listing balances the user may not see
   * (customer accounts, gift cards / store credit) are left out. null: system
   * work (the scheduled checks, read by operators), every check.
   */
  async run(
    tenantId: string,
    query: ReportQueryDto,
    scope?: ReportScope,
    permissions: readonly string[] | null = null,
  ) {
    const branchIds = branchFilter(query.branchId, scope);
    const params = [tenantId, query.from, query.to, branchIds];
    const execute = (sql: string) => {
      const bound = bindParams(sql, params);
      return this.dataSource.query<Row[]>(bound.sql, bound.values);
    };

    const totals = (await execute(
      TOTALS_BY_CURRENCY,
    )) as unknown as CurrencyTotalsRow[];

    const checks = [];
    for (const check of CHECKS) {
      if (check.storeWide && branchIds) continue;
      if (
        check.requires &&
        permissions &&
        !permissions.includes(check.requires)
      ) {
        continue;
      }
      const rows = await execute(check.sql);
      checks.push({
        key: check.key,
        label: check.label,
        description: check.description,
        passed: rows.length === 0,
        issues: rows.map((row) => ({
          reference: asText(row.reference),
          expected: Number(row.expected),
          actual: Number(row.actual),
          detail:
            row.detail === null || row.detail === undefined
              ? null
              : asText(row.detail),
        })),
      });
    }

    const byCurrency = totals.map((row) => ({
      currencyCode: row.currencyCode,
      saleCount: Number(row.saleCount ?? 0),
      salesTotal: Number(row.salesTotal ?? 0),
      linesTotal: Number(row.linesTotal ?? 0),
      paymentsNet: Number(row.paymentsNet ?? 0),
      returnsTotal: Number(row.returnsTotal ?? 0),
      refundsPaid: Number(row.refundsPaid ?? 0),
    }));
    return {
      period: { from: query.from, to: query.to },
      branchIds,
      generatedAt: new Date().toISOString(),
      // Counts add up across currencies; amounts are only ever per currency
      saleCount: byCurrency.reduce((sum, row) => sum + row.saleCount, 0),
      totals: byCurrency,
      passed: checks.every((c) => c.passed),
      checks,
    };
  }
}
