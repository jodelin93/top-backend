import type { DataSource, EntityManager } from 'typeorm';
import { branchScope } from '../auth/branch-scope';

// A data source or a transaction's manager
type Db = Pick<DataSource, 'query'> | Pick<EntityManager, 'query'>;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

interface PeriodQuery {
  from?: string;
  to?: string;
  timezone?: string;
  branchId?: string;
}

const isTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

/**
 * The store's time zone: the chosen branch's, else the first branch's (the
 * first of the user's own branches when they are limited to some; UTC when a
 * branch has none or an unknown one)
 */
export async function storeTimezone(
  manager: Db,
  tenantId: string,
  branchId?: string,
): Promise<string> {
  const scope = branchScope();
  const [row] = await manager.query<{ timezone: string | null }[]>(
    branchId
      ? `SELECT timezone FROM branches WHERE "tenantId" = $1 AND id = $2`
      : `SELECT timezone FROM branches WHERE "tenantId" = $1
            AND ($2::uuid[] IS NULL OR id = ANY($2::uuid[]))
          ORDER BY (status = 'active') DESC, created_at LIMIT 1`,
    branchId ? [tenantId, branchId] : [tenantId, scope ? [...scope] : null],
  );
  const timezone = row?.timezone?.trim();
  return timezone && isTimeZone(timezone) ? timezone : 'UTC';
}

/**
 * Report days are the store's days, whoever looks at them and from wherever:
 * the store's time zone unless the caller names one, and a date-only bound
 * (2026-10-25) is that whole local day.
 */
export async function inStoreTime<T extends PeriodQuery>(
  manager: Db,
  tenantId: string,
  query: T,
): Promise<T & { timezone: string }> {
  const timezone =
    query.timezone ?? (await storeTimezone(manager, tenantId, query.branchId));
  const from = query.from && DATE_ONLY.test(query.from) ? query.from : null;
  const to = query.to && DATE_ONLY.test(query.to) ? query.to : null;
  if (!from && !to) return { ...query, timezone };
  const [bounds] = await manager.query<
    { from: Date | null; to: Date | null }[]
  >(
    `SELECT ($1::date::timestamp AT TIME ZONE $3) AS "from",
            (($2::date + 1)::timestamp AT TIME ZONE $3) - interval '1 millisecond' AS "to"`,
    [from, to, timezone],
  );
  return {
    ...query,
    timezone,
    from:
      from && bounds.from ? new Date(bounds.from).toISOString() : query.from,
    to: to && bounds.to ? new Date(bounds.to).toISOString() : query.to,
  };
}
