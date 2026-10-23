/**
 * Whose sales a user may see (sales.view.all). Without it, a user (a cashier)
 * sees only the sales they rang up (sale.userId), wherever sales are read: the
 * sales list and details, reprints, a customer's purchases... A sale of someone
 * else is "not found", like a sale of another branch (see branch-scope).
 * Work outside a request (jobs, event consumers) is not restricted.
 */
import { NotFoundException } from '@nestjs/common';
import { requestContext } from '../common/context/request-context';
import type { ScopeFilter } from './branch-scope';

export const VIEW_ALL_SALES = 'sales.view.all';

interface SalesViewer {
  id?: string;
  permissions?: readonly string[] | null;
}

/** The user whose own sales only may be seen, or null: every sale */
export function ownSalesOnly(user?: SalesViewer | null): string | null {
  const ctx = requestContext.get();
  const id = user?.id ?? ctx?.userId;
  const permissions = user?.permissions ?? ctx?.permissions;
  // System work, or a request without a resolved user: not restricted
  if (!id || !permissions) return null;
  return permissions.includes(VIEW_ALL_SALES) ? null : id;
}

// Named parameter of the fragment below
export const OWN_SALES_PARAM = 'ownSalesUserId';

/**
 * Query builder condition limiting sales (`alias.column`: the user who rang the
 * sale up) to the user's own, or null when they see every sale.
 */
export function ownSalesFilterSql(
  alias: string,
  column = 'userId',
  user?: SalesViewer | null,
): ScopeFilter | null {
  const own = ownSalesOnly(user);
  if (!own) return null;
  return {
    sql: `"${alias}"."${column}" = :${OWN_SALES_PARAM}`,
    params: { [OWN_SALES_PARAM]: own },
  };
}

/** 404 unless the user may see this sale (theirs, or every sale) */
export function assertSaleAccess(
  sale: { userId?: string | null },
  user?: SalesViewer | null,
  notFound = 'Sale not found',
): void {
  const own = ownSalesOnly(user);
  if (own && sale.userId !== own) throw new NotFoundException(notFound);
}
