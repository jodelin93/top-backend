/**
 * Branch-level access (spec §3/§9, AC15).
 *
 * A store member works either in every branch (the default; owners always) or
 * in a set of branches (tenant_memberships."branchIds"). JwtStrategy resolves it
 * on each request onto the AuthUser (`branchIds`, null = every branch) and the
 * request context, so services deep in a call chain can apply it without the
 * user being passed down.
 *
 * - Branch records (sales, shifts, registers, estimates…) are filtered by their
 *   branch; a record outside the user's branches is "not found" (404), never
 *   "forbidden", so ids of other branches can't be probed (spec §17).
 * - Stock is held at locations, which have no branch of their own: a branch
 *   works from the warehouses assigned to it (branch_warehouses), plus the
 *   warehouses its registers sell from.
 * - Work outside a request (background jobs, event consumers) has no user and
 *   is not restricted; jobs started by a user carry the scope themselves
 *   (e.g. report exports store it and check it again at download).
 */
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { In, type EntityManager, type FindOperator } from 'typeorm';
import { requestContext } from '../common/context/request-context';
import { OWNER_ROLE } from './permissions';

/** Branches a user may work in: null = every branch */
export type BranchScope = readonly string[] | null;

/** Anything carrying a resolved scope: an AuthUser, a stored job… */
export interface BranchScoped {
  branchIds?: readonly string[] | null;
}

/** Scope of a membership row: owners and members without a list see everything */
export function membershipBranchIds(
  membership: { role?: string | null; branchIds?: string[] | null } | null,
): string[] | null {
  if (!membership || membership.role === OWNER_ROLE) return null;
  return Array.isArray(membership.branchIds)
    ? [...new Set(membership.branchIds)]
    : null;
}

/**
 * The branches a user may work in. Without a user (or one whose scope was not
 * resolved, e.g. a bare User entity): the signed-in user of the current
 * request; outside a request (system work): unrestricted.
 */
export function branchScope(user?: BranchScoped | null): BranchScope {
  if (user && user.branchIds !== undefined) return user.branchIds ?? null;
  return requestContext.get()?.branchIds ?? null;
}

/** Every branch? */
export const hasAllBranches = (scope: BranchScope = branchScope()) =>
  scope === null;

/** May the scope see this branch? A record without a branch: only all-branch users. */
export function canAccessBranch(
  branchId: string | null | undefined,
  scope: BranchScope = branchScope(),
): boolean {
  if (scope === null) return true;
  return !!branchId && scope.includes(branchId);
}

/**
 * 404 unless the user may work in the branch: a record of another branch is
 * reported as missing, so its existence doesn't leak.
 */
export function assertBranchAccess(
  user: BranchScoped | null | undefined,
  branchId: string | null | undefined,
  notFound = 'Not found',
): void {
  if (!canAccessBranch(branchId, branchScope(user))) {
    throw new NotFoundException(notFound);
  }
}

/** 403 for work that needs every branch (store-wide settings, new branches…) */
export function assertAllBranches(
  user?: BranchScoped | null,
  message = 'This needs access to every branch',
): void {
  if (branchScope(user) !== null) throw new ForbiddenException(message);
}

/** The scope as a bindable uuid[] parameter: null = no restriction */
export function scopedBranchIds(
  scope: BranchScope = branchScope(),
): string[] | null {
  return scope === null ? null : [...scope];
}

// Named parameter shared by every fragment below (same value within a request)
export const BRANCH_SCOPE_PARAM = 'branchScopeIds';

export interface ScopeFilter {
  sql: string;
  params: Record<string, unknown>;
}

/**
 * Query builder condition limiting `alias.column` (a branch id) to the scope, or
 * null when unrestricted: `if (f) qb.andWhere(f.sql, f.params)`.
 */
export function branchFilterSql(
  alias: string,
  column = 'branchId',
  scope: BranchScope = branchScope(),
): ScopeFilter | null {
  if (scope === null) return null;
  return {
    sql: `"${alias}"."${column}" = ANY(:${BRANCH_SCOPE_PARAM})`,
    params: { [BRANCH_SCOPE_PARAM]: [...scope] },
  };
}

/**
 * SQL (subquery) of the inventory locations the branches work from: locations of
 * the warehouses assigned to them, and their registers' stock locations. `p` is
 * a uuid[] parameter; `tenant` the tenant id expression.
 */
export const branchLocationIdsSql = (p: string, tenant: string) =>
  `(SELECT bl.id FROM inventory_locations bl
      JOIN branch_warehouses bw ON bw."warehouseId" = bl."warehouseId"
     WHERE bw."tenantId" = ${tenant} AND bw."branchId" = ANY(${p}::uuid[])
    UNION
    SELECT rb."defaultLocationId" FROM registers rb
     WHERE rb."tenantId" = ${tenant} AND rb."branchId" = ANY(${p}::uuid[])
       AND rb."defaultLocationId" IS NOT NULL)`;

/** SQL (subquery) of the warehouses the branches work from */
export const branchWarehouseIdsSql = (p: string, tenant: string) =>
  `(SELECT bw."warehouseId" FROM branch_warehouses bw
     WHERE bw."tenantId" = ${tenant} AND bw."branchId" = ANY(${p}::uuid[])
    UNION
    SELECT rl."warehouseId" FROM registers rb
      JOIN inventory_locations rl ON rl.id = rb."defaultLocationId"
     WHERE rb."tenantId" = ${tenant} AND rb."branchId" = ANY(${p}::uuid[]))`;

/**
 * Query builder condition limiting a location id expression (SQL, e.g.
 * '"level"."locationId"') to the scope's locations, or null when unrestricted.
 * `tenantParam` names the query's tenant parameter.
 */
export function locationFilterSql(
  locationExpr: string,
  scope: BranchScope = branchScope(),
  tenantParam = 'tenantId',
): ScopeFilter | null {
  if (scope === null) return null;
  return {
    sql: `${locationExpr} IN ${branchLocationIdsSql(`:${BRANCH_SCOPE_PARAM}`, `:${tenantParam}`)}`,
    params: { [BRANCH_SCOPE_PARAM]: [...scope] },
  };
}

/** Query builder condition limiting a warehouse id expression to the scope */
export function warehouseFilterSql(
  warehouseExpr: string,
  scope: BranchScope = branchScope(),
  tenantParam = 'tenantId',
): ScopeFilter | null {
  if (scope === null) return null;
  return {
    sql: `${warehouseExpr} IN ${branchWarehouseIdsSql(`:${BRANCH_SCOPE_PARAM}`, `:${tenantParam}`)}`,
    params: { [BRANCH_SCOPE_PARAM]: [...scope] },
  };
}

/** Condition on a register id expression: the register is at one of the branches */
export function registerFilterSql(
  registerExpr: string,
  scope: BranchScope = branchScope(),
): ScopeFilter | null {
  if (scope === null) return null;
  return {
    sql: `${registerExpr} IN (SELECT rs.id FROM registers rs WHERE rs."branchId" = ANY(:${BRANCH_SCOPE_PARAM}))`,
    params: { [BRANCH_SCOPE_PARAM]: [...scope] },
  };
}

/** Location ids the scope may see: null = all */
export async function accessibleLocationIds(
  manager: EntityManager,
  tenantId: string,
  scope: BranchScope = branchScope(),
): Promise<string[] | null> {
  if (scope === null) return null;
  if (!scope.length) return [];
  const rows = await manager.query<{ id: string }[]>(
    `SELECT id FROM ${branchLocationIdsSql('$2', '$1')} x`,
    [tenantId, [...scope]],
  );
  return rows.map((r) => r.id);
}

/** May the scope see / move stock at this location? */
export async function canAccessLocation(
  manager: EntityManager,
  tenantId: string,
  locationId: string | null | undefined,
  scope: BranchScope = branchScope(),
): Promise<boolean> {
  if (scope === null) return true;
  if (!locationId || !scope.length) return false;
  const rows = await manager.query<unknown[]>(
    `SELECT 1 FROM ${branchLocationIdsSql('$2', '$1')} x WHERE x.id = $3`,
    [tenantId, [...scope], locationId],
  );
  return rows.length > 0;
}

/** 404 unless the user may see the location */
export async function assertLocationAccess(
  manager: EntityManager,
  tenantId: string,
  locationId: string | null | undefined,
  notFound = 'Location not found',
  scope: BranchScope = branchScope(),
): Promise<void> {
  if (!(await canAccessLocation(manager, tenantId, locationId, scope))) {
    throw new NotFoundException(notFound);
  }
}

/** Branch of a register (null: unknown register) */
export async function registerBranchId(
  manager: EntityManager,
  tenantId: string,
  registerId: string | null | undefined,
): Promise<string | null> {
  if (!registerId) return null;
  const rows = await manager.query<{ branchId: string }[]>(
    `SELECT "branchId" FROM registers WHERE id = $1 AND "tenantId" = $2`,
    [registerId, tenantId],
  );
  return rows[0]?.branchId ?? null;
}

/**
 * 404 unless the register belongs to this store and is at one of the user's
 * branches. The store check applies to every-branch users too: a guessed id of
 * another store's register must never be accepted (tenant isolation).
 */
export async function assertRegisterAccess(
  manager: EntityManager,
  tenantId: string,
  registerId: string | null | undefined,
  notFound = 'Register not found',
  scope: BranchScope = branchScope(),
): Promise<void> {
  if (!registerId) return;
  const branchId = await registerBranchId(manager, tenantId, registerId);
  if (branchId === null) throw new NotFoundException(notFound);
  if (!canAccessBranch(branchId, scope)) throw new NotFoundException(notFound);
}

/**
 * Can a user holding `granter` give (or manage someone with) `granted`?
 * Every-branch access only from an every-branch user; otherwise a subset.
 */
export function isBranchSubset(
  granted: BranchScope,
  granter: BranchScope,
): boolean {
  if (granter === null) return true;
  if (granted === null) return false;
  return granted.every((id) => granter.includes(id));
}

/**
 * TypeORM `where` fragment limiting a `branchId` column to the scope (spread it
 * into a find's where): {} when unrestricted.
 */
export function branchWhere(
  scope: BranchScope = branchScope(),
  column = 'branchId',
): Record<string, FindOperator<string>> {
  return scope === null ? {} : { [column]: In([...scope]) };
}
