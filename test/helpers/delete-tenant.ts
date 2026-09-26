import { DataSource } from 'typeorm';

/**
 * Delete a throwaway e2e store and everything in it.
 *
 * Several ledgers are append-only (audit log, stock movements, customer credit,
 * stored value): their triggers allow DELETE only under the `app.audit_purge`
 * flag. The flag is set for one dedicated connection (session level) and reset
 * before the connection goes back to the pool, so it never leaks to other work.
 * Tables still referenced by another tenant table are retried on the next pass.
 */
export async function deleteTenant(
  dataSource: DataSource,
  tenantId: string,
  userIds: Set<string> = new Set(),
) {
  const runner = dataSource.createQueryRunner();
  await runner.connect();
  try {
    await runner.query(`SELECT set_config('app.audit_purge', 'on', false)`);

    const memberRows = (await runner.query(
      `SELECT "userId" FROM tenant_memberships WHERE "tenantId" = $1`,
      [tenantId],
    )) as { userId: string }[];
    memberRows.forEach((row) => userIds.add(row.userId));

    const tableRows = (await runner.query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'tenantId'
         AND table_name <> 'tenants'`,
    )) as { table_name: string }[];
    let remaining = tableRows.map((row) => row.table_name);

    // Self-referencing rows first
    await runner.query(
      `UPDATE categories SET "parentId" = NULL WHERE "tenantId" = $1`,
      [tenantId],
    );

    for (let pass = 0; pass < 12 && remaining.length > 0; pass++) {
      const blocked: string[] = [];
      for (const table of remaining) {
        try {
          await runner.query(`DELETE FROM "${table}" WHERE "tenantId" = $1`, [
            tenantId,
          ]);
        } catch {
          // Still referenced by another tenant table; retry next pass
          blocked.push(table);
        }
      }
      remaining = blocked;
    }
    if (remaining.length > 0) {
      throw new Error(
        `E2E cleanup could not empty: ${remaining.join(', ')} (tenant ${tenantId})`,
      );
    }

    await runner.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    // Delete triggers on catalog tables append to sync_change_log while the
    // tables above are emptied (after it was); it has no FK to tenants
    await runner.query(`DELETE FROM sync_change_log WHERE "tenantId" = $1`, [
      tenantId,
    ]);
    // Only users this run created, and only if no other store uses them
    await runner.query(
      `DELETE FROM users WHERE id = ANY($1)
         AND NOT EXISTS (SELECT 1 FROM tenant_memberships m WHERE m."userId" = users.id)`,
      [[...userIds]],
    );
  } finally {
    await runner.query(`SELECT set_config('app.audit_purge', '', false)`);
    await runner.release();
  }
}
