/**
 * Stock ledger rules (D018, ledger integrity, stock status, aging). Pure
 * functions, unit tested in stock-rules.spec.ts.
 */
import { LocationStockStatus } from '../database/entities/inventory-location.entity';
import { subQty } from '../common/utils/quantity';

// ---- D018: negative stock is never allowed ----

export interface StockPosition {
  quantityOnHand: number;
  quantityReserved: number;
}

/**
 * Whether `quantity` units can leave a stock level. On hand never goes below
 * zero; with respectReservations (the default) reserved units stay put too.
 * Returns the refusal message, or null when the movement is allowed.
 */
export function canGoOut(
  level: StockPosition,
  quantity: number,
  options: { respectReservations?: boolean } = {},
): string | null {
  if (quantity <= 0) return null;
  const onHand = Number(level.quantityOnHand);
  if (options.respectReservations === false) {
    return subQty(onHand, quantity) < 0
      ? `Not enough stock (${Math.max(onHand, 0)} on hand)`
      : null;
  }
  // Exact for decimal (measured) quantities: 0.3 − 0.1 − 0.2 is 0, not below
  const available = subQty(onHand, Number(level.quantityReserved));
  return subQty(available, quantity) < 0
    ? `Not enough stock (${Math.max(available, 0)} available)`
    : null;
}

// ---- Ledger source identity ----

export const SOURCE_KEY_MAX = 200;

export interface SourceKeyInput {
  referenceType?: string;
  referenceId?: string;
  variantId: string;
  locationId: string;
  movementType: string;
}

/**
 * Default identity of a movement's business event:
 * referenceType:referenceId:variantId:locationId:movementType.
 * Null without a reference (nothing identifies the event).
 */
export function defaultSourceKey(input: SourceKeyInput): string | null {
  if (!input.referenceId) return null;
  return [
    input.referenceType ?? 'ref',
    input.referenceId,
    input.variantId,
    input.locationId,
    input.movementType,
  ]
    .join(':')
    .slice(0, SOURCE_KEY_MAX);
}

/**
 * The n-th posting of the same default key inside one transaction (e.g. a sale
 * with two lines of the same variant) gets a #n suffix, so the lines stay two
 * events while a retried transaction produces the same keys again.
 */
export function sourceKeyWithOccurrence(key: string, occurrence: number) {
  if (occurrence <= 1) return key;
  const suffix = `#${occurrence}`;
  return key.slice(0, SOURCE_KEY_MAX - suffix.length) + suffix;
}

/**
 * Key of one leg of a multi-step event, e.g. transferKey(id, eventId, itemId, 'out')
 */
export const eventKey = (...parts: (string | number)[]) =>
  parts.join(':').slice(0, SOURCE_KEY_MAX);

/**
 * A duplicate posting is only "already applied" when it moved the same signed
 * quantity; anything else is a conflicting reuse of the key.
 */
export function isSameMovement(
  existing: {
    quantity: number;
    fromLocationId: string | null;
    toLocationId: string | null;
  },
  locationId: string,
  delta: number,
): boolean {
  const signed =
    existing.toLocationId === locationId
      ? Number(existing.quantity)
      : existing.fromLocationId === locationId
        ? -Number(existing.quantity)
        : NaN;
  return Math.abs(signed - delta) < 0.00005;
}

// ---- Stock status ----

/** Only sellable locations count towards what can be sold */
export const countsAsAvailable = (status: LocationStockStatus) =>
  status === LocationStockStatus.SELLABLE;

/** isSellable mirrors stockStatus */
export function locationStatusFields(input: {
  stockStatus?: LocationStockStatus;
  isSellable?: boolean;
}): { stockStatus?: LocationStockStatus; isSellable?: boolean } {
  if (input.stockStatus) {
    return {
      stockStatus: input.stockStatus,
      isSellable: input.stockStatus === LocationStockStatus.SELLABLE,
    };
  }
  if (input.isSellable !== undefined) {
    return {
      isSellable: input.isSellable,
      stockStatus: input.isSellable
        ? LocationStockStatus.SELLABLE
        : LocationStockStatus.QUARANTINE,
    };
  }
  return {};
}

export type GoodsCondition = 'good' | 'damaged';

/**
 * Where goods in a given condition go within a warehouse: good → the location
 * asked for; damaged → the warehouse's damaged location, else its quarantine
 * location, else (none) the location asked for.
 */
export function pickConditionLocation(
  requestedLocationId: string,
  condition: GoodsCondition,
  warehouseLocations: { id: string; stockStatus: LocationStockStatus }[],
): string {
  if (condition !== 'damaged') return requestedLocationId;
  const damaged = warehouseLocations.find(
    (l) => l.stockStatus === LocationStockStatus.DAMAGED,
  );
  const quarantine = warehouseLocations.find(
    (l) => l.stockStatus === LocationStockStatus.QUARANTINE,
  );
  return (damaged ?? quarantine)?.id ?? requestedLocationId;
}

// ---- Stock aging ----

export const AGING_BUCKETS = [
  { key: '0-30', min: 0, max: 30 },
  { key: '31-60', min: 31, max: 60 },
  { key: '61-90', min: 61, max: 90 },
  { key: '91-180', min: 91, max: 180 },
  { key: '181+', min: 181, max: Infinity },
] as const;

export type AgingBucketKey = (typeof AGING_BUCKETS)[number]['key'] | 'unknown';

/** Whole days between `since` and `now` (null when never received) */
export function daysSince(
  since: Date | string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!since) return null;
  const time = new Date(since).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now.getTime() - time) / 86_400_000));
}

export function agingBucket(days: number | null): AgingBucketKey {
  if (days === null) return 'unknown';
  return AGING_BUCKETS.find((b) => days >= b.min && days <= b.max)!.key;
}
