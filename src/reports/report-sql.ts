/**
 * Shared SQL plumbing for reports: parameter binding, the branch filter and the
 * access scope.
 *
 * Branch filter. A report's branch restriction is one bound uuid[] parameter
 * (NULL = every branch). It is computed centrally from what the user asked for
 * (`branchId`) and what they may see (`ReportScope`), so branch-scoped access
 * only has to fill `ReportScope.branchIds` — every report, the dashboard and
 * exports then honour it.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { branchLocationIdsSql } from '../auth/branch-scope';

/** What a user may see. `branchIds` present: only these branches (may be empty). */
export interface ReportScope {
  branchIds?: string[];
}

/**
 * Scope of a signed-in user: the branches of a branch-limited member
 * (AuthUser.branchIds, see auth/branch-scope); undefined = every branch.
 */
export function scopeOf(user: unknown): ReportScope | undefined {
  const ids = (user as { branchIds?: unknown } | null)?.branchIds;
  return Array.isArray(ids)
    ? { branchIds: ids.filter((id): id is string => typeof id === 'string') }
    : undefined;
}

/**
 * Branches a query is restricted to: null = no restriction. A requested branch
 * outside the scope is refused; with a scope and no request, the whole scope.
 */
export function branchFilter(
  requested: string | null | undefined,
  scope?: ReportScope,
): string[] | null {
  if (scope?.branchIds) {
    if (requested) {
      if (!scope.branchIds.includes(requested)) {
        throw new ForbiddenException('You do not have access to this branch');
      }
      return [requested];
    }
    return [...scope.branchIds];
  }
  return requested ? [requested] : null;
}

/**
 * Store-wide figures (suppliers, audit trail…) can't be split by branch: refused
 * for a branch-limited user, and a branch filter is a mistake.
 */
export function assertStoreWide(
  requested: string | null | undefined,
  scope?: ReportScope,
) {
  if (scope?.branchIds) {
    throw new ForbiddenException(
      'This report covers the whole store and needs access to every branch',
    );
  }
  if (requested) {
    throw new BadRequestException(
      'This report covers the whole store and cannot be filtered by branch',
    );
  }
}

/**
 * Bind positional parameters, keeping only those the query uses: placeholders
 * are renumbered ($1, $5 → $1, $2), since Postgres can't type an unused one.
 */
export function bindParams(
  sql: string,
  params: readonly unknown[],
): { sql: string; values: unknown[] } {
  const used = [
    ...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))),
  ].sort((a, b) => a - b);
  for (const n of used) {
    if (n < 1 || n > params.length) {
      throw new Error(`Query uses $${n} but only ${params.length} are bound`);
    }
  }
  const renumber = new Map(used.map((n, i) => [n, i + 1]));
  return {
    sql: sql.replace(
      /\$(\d+)/g,
      (_, n: string) => `$${renumber.get(Number(n))}`,
    ),
    values: used.map((n) => params[n - 1]),
  };
}

// ---- Branch fragments. `p` is the uuid[] placeholder, e.g. '$5' ----

const all = (p: string) => `${p}::uuid[] IS NULL`;

/** Sale `s` rung up at one of the branches */
export const saleInBranch = (p: string, alias = 's') =>
  `(${all(p)} OR ${alias}."branchId" = ANY(${p}::uuid[]))`;

/** Register id expression belonging to one of the branches */
export const registerInBranch = (p: string, registerId: string) =>
  `(${all(p)} OR EXISTS (SELECT 1 FROM registers rb WHERE rb.id = ${registerId} AND rb."branchId" = ANY(${p}::uuid[])))`;

/** Return `r`: the branch of the register it was processed at */
export const returnInBranch = (p: string, alias = 'r') =>
  registerInBranch(p, `${alias}."registerId"`);

/** Shift `sh`: its branch (older shifts: its register's) */
export const shiftInBranch = (p: string, alias = 'sh') =>
  `(${all(p)} OR COALESCE(${alias}."branchId", (SELECT rb."branchId" FROM registers rb WHERE rb.id = ${alias}."registerId")) = ANY(${p}::uuid[]))`;

/**
 * Inventory locations of the branches: locations of the warehouses assigned to
 * them (branch_warehouses) and the stock locations their registers sell from
 * (locations have no branch of their own). Needs $1 = tenant id.
 */
export const branchLocations = (p: string) => branchLocationIdsSql(p, '$1');

/** Location id expression at one of the branches */
export const locationInBranch = (p: string, locationId: string) =>
  `(${all(p)} OR ${locationId} IN ${branchLocations(p)})`;

/** Expense `e`: the branch of its register (or of its shift's register) */
export const expenseInBranch = (p: string, alias = 'e') =>
  registerInBranch(
    p,
    `COALESCE(${alias}."registerId", (SELECT es."registerId" FROM shifts es WHERE es.id = ${alias}."shiftId"))`,
  );
