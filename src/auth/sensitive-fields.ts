import { StreamableFile } from '@nestjs/common';
import type { Permission } from './permissions';

/**
 * Response fields only some users may see, and the permission that reveals them.
 * SensitiveFieldsInterceptor removes them (at any depth) from every API response
 * for users without that permission: products, variants, stock views, sale lines,
 * customers embedded in sales... Writing them is governed by the route's own
 * permission (e.g. catalog.manage sets a product's cost).
 */
// Purchasing staff work with supplier costs on orders and receipts, so they see them
const COST_VIEWERS: readonly Permission[] = [
  'inventory.cost.view',
  'purchasing.manage',
  'purchasing.approve',
];

/** Field → the permissions that reveal it (any one of them) */
export const SENSITIVE_FIELDS: Readonly<Record<string, readonly Permission[]>> =
  {
    // Product costs, cost layers and stock value
    cost: COST_VIEWERS,
    unitCost: COST_VIEWERS,
    totalCost: COST_VIEWERS,
    averageCost: COST_VIEWERS,
    currentCost: COST_VIEWERS,
    costLayers: COST_VIEWERS,
    stockValue: COST_VIEWERS,
    // Customer account
    currentBalance: ['customers.finance.view'],
    creditLimit: ['customers.finance.view'],
    // Only the customer account uses this key. balance / available / aging /
    // balanceAfter are also gift card, loyalty and payables fields, so the account
    // payment route leaves them out itself (CustomerCreditService.recordPayment)
    ledgerBalance: ['customers.finance.view'],
  };

/** Fields to leave out of responses for someone holding `permissions` */
export function hiddenFieldsFor(
  permissions: readonly string[] | undefined,
): Set<string> {
  const held = new Set(permissions ?? []);
  return new Set(
    Object.entries(SENSITIVE_FIELDS)
      .filter(([, permissions]) => !permissions.some((p) => held.has(p)))
      .map(([field]) => field),
  );
}

const isOpaque = (value: object) =>
  value instanceof Date ||
  value instanceof StreamableFile ||
  value instanceof Map ||
  value instanceof Set ||
  ArrayBuffer.isView(value) ||
  value instanceof ArrayBuffer ||
  typeof (value as { pipe?: unknown }).pipe === 'function';

/**
 * A copy of `value` without the `hidden` fields, at any depth. Objects that contain
 * nothing to hide are returned as they are, and the originals are never modified
 * (entities may be cached); copies keep their class, so @Exclude() still applies.
 */
export function redactFields<T>(value: T, hidden: ReadonlySet<string>): T {
  if (!hidden.size) return value;
  return redact(value, hidden, new Map()) as T;
}

function redact(
  value: unknown,
  hidden: ReadonlySet<string>,
  seen: Map<object, unknown>,
): unknown {
  if (value === null || typeof value !== 'object' || isOpaque(value)) {
    return value;
  }
  if (seen.has(value)) return seen.get(value);
  seen.set(value, value);

  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    value.forEach((item: unknown, index) => {
      const next = redact(item, hidden, seen);
      if (next !== item) {
        copy ??= [...(value as unknown[])];
        copy[index] = next;
      }
    });
    if (copy) seen.set(value, copy);
    return copy ?? value;
  }

  const source = value as Record<string, unknown>;
  let copy: Record<string, unknown> | undefined;
  const ensureCopy = () =>
    (copy ??= Object.assign(
      Object.create(Object.getPrototypeOf(source) as object | null) as Record<
        string,
        unknown
      >,
      source,
    ));
  for (const key of Object.keys(source)) {
    if (hidden.has(key)) {
      delete ensureCopy()[key];
      continue;
    }
    const next = redact(source[key], hidden, seen);
    if (next !== source[key]) ensureCopy()[key] = next;
  }
  if (copy) seen.set(value, copy);
  return copy ?? value;
}
