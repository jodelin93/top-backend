import { DataSource } from 'typeorm';

// Advisory lock keys of the background jobs (any stable 32-bit numbers)
export const LOCKS = {
  notificationChecks: 7_420_001,
  reconciliation: 7_420_002,
  housekeeping: 7_420_003,
  giftCardExpiry: 7_420_004,
  syncLogPrune: 7_420_005,
} as const;

/**
 * Run `job` once a day on one API instance at a time (advisory lock): a first
 * pass `firstRunAfterMs` after start, then every 24 hours. Set `envSwitch` to
 * "off" to disable it. Returns a stop function (onModuleDestroy).
 */
export function scheduleDaily(
  dataSource: DataSource,
  options: {
    lockKey: number;
    envSwitch: string;
    firstRunAfterMs?: number;
    job: () => Promise<unknown>;
    onError: (error: unknown) => void;
  },
): () => void {
  if (process.env[options.envSwitch] === 'off') return () => undefined;
  const run = () =>
    void runExclusive(dataSource, options.lockKey, options.job).catch(
      options.onError,
    );
  const first = setTimeout(run, options.firstRunAfterMs ?? 5 * 60_000);
  const timer = setInterval(run, 24 * 3_600_000);
  // Never keep the process alive just for this
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

/**
 * Run `fn` on one API instance at a time: the first to take the Postgres
 * advisory lock runs it, the others skip (returns undefined). The lock is held
 * by an open transaction and released when `fn` settles, even on a crash.
 */
export async function runExclusive<T>(
  dataSource: DataSource,
  lockKey: number,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  return dataSource.transaction(async (manager) => {
    const [row] = await manager.query<{ locked: boolean }[]>(
      'SELECT pg_try_advisory_xact_lock($1) AS locked',
      [lockKey],
    );
    if (!row?.locked) return undefined;
    return fn();
  });
}

/** Ids of the stores the background checks run for */
export async function activeTenantIds(dataSource: DataSource) {
  const rows = await dataSource.query<{ id: string }[]>(
    `SELECT id FROM tenants WHERE status = 'active' ORDER BY created_at`,
  );
  return rows.map((r) => r.id);
}

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
