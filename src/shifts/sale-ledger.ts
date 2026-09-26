import type { EntityManager } from 'typeorm';
import { returnedRows } from '../platform/outbox/event-handler.registry';

/**
 * Per-sale drawer ledger (spec §13/§18): one cash_movements row of type 'sale'
 * per sale that left cash in the drawer, amount = net cash kept in the shift
 * currency (cash tendered without a foreign tender − change given in that
 * currency). Linked by sourceType 'sale' + the sale id, so the unique index
 * uq_cash_movement_source makes it idempotent.
 *
 * These rows are a trace only: the expected cash keeps deriving cash sales from
 * payments and excludes 'sale' movements (see LEDGER_ONLY_TYPES).
 */

// Sales that put cash in the drawer, and payments that count (as in ShiftsService)
export const LEDGER_SALE_STATUSES = [
  'completed',
  'refunded',
  'partially_refunded',
];
export const LEDGER_PAYMENT_STATUSES = ['completed', 'captured', 'refunded'];

/**
 * SQL expression of a sale's net cash kept in the sale currency; `s` is the sale
 * row and `pay` the parameter holding LEDGER_PAYMENT_STATUSES
 */
export function netCashSql(pay: string): string {
  return `ROUND(
    COALESCE((SELECT SUM(p.amount) FROM payments p
              JOIN payment_methods pm ON pm.id = p."paymentMethodId"
              WHERE p."saleId" = s.id AND p."tenantId" = s."tenantId"
                AND pm."methodType" = 'cash' AND p."tenderedCurrency" IS NULL
                AND p.status::text = ANY(${pay})), 0)
    - CASE WHEN s.metadata->'changeTender' IS NULL
             OR jsonb_typeof(s.metadata->'changeTender') = 'null'
           THEN COALESCE(s."changeAmount", 0) ELSE 0 END, 2)`;
}

export interface SaleLedgerRow {
  id: string;
  shiftId: string;
  sourceId: string;
  amount: string | number;
}

/**
 * Record the 'sale' movement of one sale, or of every sale of a shift that has
 * none yet (backfill). Returns only the rows inserted now.
 */
export async function syncSaleCashMovements(
  manager: Pick<EntityManager, 'query'>,
  scope: { tenantId: string; saleId?: string; shiftId?: string },
): Promise<SaleLedgerRow[]> {
  if (!scope.saleId && !scope.shiftId) return [];
  const params: unknown[] = [
    scope.tenantId,
    LEDGER_SALE_STATUSES,
    LEDGER_PAYMENT_STATUSES,
  ];
  let filter: string;
  if (scope.saleId) {
    params.push(scope.saleId);
    filter = `s.id = $4 AND s."shiftId" IS NOT NULL`;
  } else {
    params.push(scope.shiftId);
    filter = `s."shiftId" = $4`;
  }
  const result = await manager.query<unknown>(
    `INSERT INTO cash_movements
       ("tenantId", "shiftId", "registerId", type, amount, reason, reference,
        "sourceType", "sourceId", "userId")
     SELECT x."tenantId", x."shiftId", x."registerId", 'sale', x.net, 'Cash sale',
            x."saleNumber", 'sale', x.id, x."userId"
     FROM (
       SELECT s.id, s."tenantId", s."shiftId", sh."registerId", s."saleNumber", s."userId",
              ${netCashSql('$3')} AS net
       FROM sales s
       JOIN shifts sh ON sh.id = s."shiftId" AND sh."tenantId" = s."tenantId"
       WHERE s."tenantId" = $1 AND ${filter}
         AND s.status::text = ANY($2) AND s."userId" IS NOT NULL
     ) x
     WHERE x.net > 0
     ON CONFLICT ("tenantId", "sourceType", "sourceId") WHERE "sourceId" IS NOT NULL
     DO NOTHING
     RETURNING id, "shiftId", "sourceId", amount`,
    params,
  );
  return returnedRows<SaleLedgerRow>(result);
}
