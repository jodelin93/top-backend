import { EntityManager } from 'typeorm';

/**
 * Next human-readable document number for a tenant, e.g. S-000042 or
 * MAIN-000042 (per-branch numbers use the branch prefix, see branchDocumentPrefix).
 * Must run inside the transaction that stores the document.
 *
 * Each sequence (tenant + table + column + prefix) has a counter row in
 * document_sequences: taking a number is one UPDATE of that row (constant time,
 * however many documents exist). Its row lock is held until the transaction ends,
 * so concurrent callers of one sequence queue, numbers follow commit order and a
 * rolled-back document gives its number back — gap-free.
 *
 * First use of a sequence seeds the counter from the highest `{prefix}-{digits}`
 * already stored (existing data), under an advisory lock so only one caller seeds.
 */
export async function nextDocumentNumber(
  manager: EntityManager,
  options: { table: string; column: string; tenantId: string; prefix: string },
): Promise<string> {
  const { table, column, tenantId, prefix } = options;
  const key = `${table}:${column}:${prefix}`;
  const format = (value: number | string) =>
    `${prefix}-${String(Number(value)).padStart(6, '0')}`;

  const bumped = returnedRows<{ lastValue: string }>(
    await manager.query(
      `UPDATE document_sequences SET "lastValue" = "lastValue" + 1, updated_at = NOW()
       WHERE "tenantId" = $1 AND "sequenceKey" = $2
       RETURNING "lastValue"`,
      [tenantId, key],
    ),
  );
  if (bumped.length) return format(bumped[0].lastValue);

  // First number of this sequence: continue from the documents already stored
  await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `${table}:${tenantId}:${prefix}`,
  ]);
  const [{ max }] = await manager.query<{ max: number | null }[]>(
    `SELECT MAX(CAST(SUBSTRING("${column}" FROM $3::int) AS INTEGER)) AS max
     FROM "${table}" WHERE "tenantId" = $1 AND "${column}" ~ $2`,
    [tenantId, `^${escapeRegex(prefix)}-[0-9]+$`, prefix.length + 2],
  );
  // Another caller may have created the row meanwhile: then just take the next one
  const [created] = returnedRows<{ lastValue: string }>(
    await manager.query(
      `INSERT INTO document_sequences ("tenantId", "sequenceKey", "lastValue")
       VALUES ($1, $2, $3)
       ON CONFLICT ("tenantId", "sequenceKey")
       DO UPDATE SET "lastValue" = document_sequences."lastValue" + 1, updated_at = NOW()
       RETURNING "lastValue"`,
      [tenantId, key, (max ?? 0) + 1],
    ),
  );
  // RETURNING always yields the row; the inserted value is the fallback
  return format(created?.lastValue ?? (max ?? 0) + 1);
}

// node-postgres returns [rows, count] for UPDATE ... RETURNING through TypeORM
function returnedRows<T>(result: unknown): T[] {
  if (Array.isArray(result) && Array.isArray(result[0]))
    return result[0] as T[];
  return (result as T[]) ?? [];
}

// Provisional sale numbers (held carts, payments pending) and offline receipts
const RESERVED_PREFIXES = ['H', 'P', 'OFFLINE'];

/**
 * Prefix of a branch's documents (D017): its code upper-cased, keeping letters,
 * digits and dashes (max 20 characters). A code that would read like a provisional
 * number (H, P, OFFLINE) gets a "B-" in front so the sequences never mix.
 */
export function branchDocumentPrefix(code: string | null | undefined): string {
  const clean = (code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]+/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, 20);
  if (!clean) return 'B';
  return RESERVED_PREFIXES.includes(clean) ? `B-${clean}` : clean;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
