import type { DataSource, EntityManager } from 'typeorm';

/** How long one report may keep the database busy (REPORT_TIMEOUT_MS) */
export const reportTimeoutMs = () => {
  const ms = Number(process.env.REPORT_TIMEOUT_MS);
  return Number.isInteger(ms) && ms >= 1000 ? ms : 30_000;
};

/**
 * Run report queries with a statement timeout (read only, in one transaction):
 * a report that would scan too much is stopped by Postgres instead of slowing
 * the tills down.
 */
export function withReportTimeout<T>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return dataSource.transaction(async (manager) => {
    await manager.query(`SET LOCAL statement_timeout = ${reportTimeoutMs()}`);
    return work(manager);
  });
}
