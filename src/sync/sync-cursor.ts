/**
 * Opaque sync cursor v2 (unit tested in sync-cursor.spec.ts).
 *
 * Changes come from `sync_change_log`, a per-store log written by triggers on
 * the catalog, prices, stock, customers and POS context tables (deletions
 * included, as tombstones). Each row has a monotonic `seq` and the id of the
 * transaction that wrote it (`txid`, xid8).
 *
 * `seq` is handed out at insert time, not at commit, so a transaction still
 * running when a page is read can later commit rows with a smaller seq than
 * rows already delivered. The cursor therefore keeps, next to the last seq
 * delivered (`s`), the xmin of the snapshot it was read in (`x`): every row
 * that was invisible then belongs to a transaction with txid >= x. The next
 * read delivers rows with seq > s plus rows with seq <= s and txid >= x (a few
 * rows may come twice; clients upsert). All reads of one request share one
 * REPEATABLE READ snapshot, the consistent boundary.
 */
export interface SyncCursor {
  v: 2;
  // Last change-log seq delivered (bigint as text)
  s: string;
  // xmin of the snapshot the cursor was issued in (xid8 as text)
  x: string;
  // Register (stock location, branch assortment) the cursor was issued for
  r: string | null;
  // Branch of that register when issued
  b: string | null;
  // When the cursor was issued (ISO)
  at: string;
}

export type ResetReason =
  | 'first_sync'
  | 'invalid_cursor'
  | 'cursor_too_old'
  | 'register_changed'
  | 'price_lists_changed'
  | 'too_many_changes';

// Older cursors trigger a full download (the change log is pruned after this)
export const MAX_CURSOR_AGE_MS = 7 * 24 * 3600_000;
// Log retention (a little longer than the oldest cursor still accepted)
export const CHANGE_LOG_RETENTION = '8 days';

const DIGITS = /^\d+$/;

export function encodeCursor(cursor: SyncCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/** Parse a cursor; null when malformed or from an older version (full download). */
export function decodeCursor(
  raw: string | undefined | null,
): SyncCursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Partial<SyncCursor>;
    if (
      value.v !== 2 ||
      typeof value.s !== 'string' ||
      !DIGITS.test(value.s) ||
      typeof value.x !== 'string' ||
      !DIGITS.test(value.x) ||
      typeof value.at !== 'string' ||
      Number.isNaN(Date.parse(value.at))
    ) {
      return null;
    }
    return { ...value, r: value.r ?? null, b: value.b ?? null } as SyncCursor;
  } catch {
    return null;
  }
}

/** Why the client must download everything again (null: continue with deltas). */
export function resetReasonFor(
  raw: string | undefined | null,
  cursor: SyncCursor | null,
  context: { now: string; registerId: string | null; branchId: string | null },
): ResetReason | null {
  if (!raw) return 'first_sync';
  if (!cursor) return 'invalid_cursor';
  if (Date.parse(context.now) - Date.parse(cursor.at) > MAX_CURSOR_AGE_MS) {
    return 'cursor_too_old';
  }
  if (cursor.r !== context.registerId || cursor.b !== context.branchId) {
    return 'register_changed';
  }
  return null;
}

const maxSeq = (a: string, b: string) => (BigInt(a) >= BigInt(b) ? a : b);

/**
 * Cursor after a read: `s` moves to the last row delivered (never backwards),
 * `x` to the xmin of the snapshot just read.
 */
export function advanceCursor(
  cursor: SyncCursor,
  read: { lastSeq: string | null; xmin: string; now: string },
): SyncCursor {
  return {
    ...cursor,
    s: read.lastSeq ? maxSeq(cursor.s, read.lastSeq) : cursor.s,
    x: read.xmin,
    at: read.now,
  };
}

// ---- Interpreting change-log rows ----

export interface ChangeRow {
  seq: string;
  entity: string;
  entityId: string;
  op: 'U' | 'D';
  // stock rows: the location
  scope: string | null;
}

// Entities whose change means "send the POS context again"
const CONTEXT_ENTITIES = new Set([
  'category',
  'tax',
  'payment_method',
  'settings',
  'register',
  'branch',
]);

export interface ChangeSet {
  variantIds: string[];
  // Variants deleted outright (tombstones)
  deletedVariantIds: string[];
  productIds: string[];
  customerIds: string[];
  deletedCustomerIds: string[];
  contextChanged: boolean;
  priceListsChanged: boolean;
}

/**
 * What a batch of log rows touches. Stock rows only count for the register's
 * own location; a deleted row is a tombstone unless re-created later in the batch.
 */
export function collectChanges(
  rows: ChangeRow[],
  locationId: string | null,
): ChangeSet {
  const variants = new Map<string, 'U' | 'D'>();
  const customers = new Map<string, 'U' | 'D'>();
  const products = new Set<string>();
  let contextChanged = false;
  let priceListsChanged = false;
  const ordered = [...rows].sort((a, b) =>
    BigInt(a.seq) < BigInt(b.seq) ? -1 : BigInt(a.seq) > BigInt(b.seq) ? 1 : 0,
  );
  for (const row of ordered) {
    switch (row.entity) {
      case 'variant':
        variants.set(row.entityId, row.op);
        break;
      case 'stock':
        if (
          locationId &&
          row.scope === locationId &&
          !variants.has(row.entityId)
        ) {
          variants.set(row.entityId, 'U');
        }
        break;
      case 'product':
        products.add(row.entityId);
        break;
      case 'customer':
        customers.set(row.entityId, row.op);
        break;
      case 'price_list':
        priceListsChanged = true;
        break;
      default:
        if (CONTEXT_ENTITIES.has(row.entity)) contextChanged = true;
    }
  }
  const ids = (map: Map<string, 'U' | 'D'>, op: 'U' | 'D') =>
    [...map].filter(([, o]) => o === op).map(([id]) => id);
  return {
    variantIds: ids(variants, 'U'),
    deletedVariantIds: ids(variants, 'D'),
    productIds: [...products],
    customerIds: ids(customers, 'U'),
    deletedCustomerIds: ids(customers, 'D'),
    contextChanged,
    priceListsChanged,
  };
}
