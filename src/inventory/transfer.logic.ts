/**
 * Stock transfer rules (R067). Pure functions, unit tested in transfer.logic.spec.ts.
 */
import { StockTransferStatus } from '../database/entities/stock-transfer.entity';
import {
  addQty,
  floorQty,
  isQuantityValue,
  roundQty,
  subQty,
} from '../common/utils/quantity';

export type TransferAction =
  | 'edit'
  | 'request'
  | 'approve'
  | 'reject'
  | 'dispatch'
  | 'receive'
  | 'writeOff'
  | 'cancel';

// Units have left the source: receipts, write-offs and returns are possible
const DISPATCHED: readonly StockTransferStatus[] = [
  StockTransferStatus.PARTIALLY_DISPATCHED,
  StockTransferStatus.IN_TRANSIT,
  StockTransferStatus.PARTIALLY_RECEIVED,
];

export const TRANSFER_ALLOWED_FROM: Record<
  TransferAction,
  readonly StockTransferStatus[]
> = {
  edit: [StockTransferStatus.DRAFT],
  request: [StockTransferStatus.DRAFT],
  approve: [StockTransferStatus.REQUESTED],
  reject: [StockTransferStatus.REQUESTED],
  // From draft only when no approval is needed (checked by the service)
  dispatch: [
    StockTransferStatus.DRAFT,
    StockTransferStatus.APPROVED,
    StockTransferStatus.PARTIALLY_DISPATCHED,
  ],
  receive: DISPATCHED,
  writeOff: DISPATCHED,
  // After dispatch, what is still in transit goes back to the source
  cancel: [
    StockTransferStatus.DRAFT,
    StockTransferStatus.REQUESTED,
    StockTransferStatus.APPROVED,
    ...DISPATCHED,
  ],
};

export function transferTransitionError(
  status: StockTransferStatus,
  action: TransferAction,
): string | null {
  if (TRANSFER_ALLOWED_FROM[action].includes(status)) return null;
  const verb = {
    edit: 'edited',
    request: 'submitted for approval',
    approve: 'approved',
    reject: 'rejected',
    dispatch: 'dispatched',
    receive: 'received',
    writeOff: 'written off',
    cancel: 'cancelled',
  }[action];
  return `A ${status.replace(/_/g, ' ')} transfer cannot be ${verb}`;
}

export interface TransferItemState {
  id: string;
  variantId: string;
  quantityRequested: number;
  quantityDispatched: number;
  quantityReceived: number;
  quantityWrittenOff: number;
  quantityDamaged?: number;
  quantityReturned?: number;
  quantityMissing?: number;
  quantityOverReceived?: number;
}

export interface TransferLineInput {
  itemId: string;
  quantity: number;
}

// Dispatched units that have not arrived (good or damaged), been written off
// or gone back to the source
// (exact for decimal quantities of measured items)
export const outstandingInTransit = (item: TransferItemState): number =>
  subQty(
    item.quantityDispatched,
    addQty(
      item.quantityReceived,
      item.quantityDamaged ?? 0,
      item.quantityWrittenOff,
      item.quantityReturned ?? 0,
    ),
  );

// Requested units not dispatched yet
export const remainingToDispatch = (item: TransferItemState): number =>
  Math.max(0, subQty(item.quantityRequested, item.quantityDispatched));

type Plan<T> = { lines: { item: T; quantity: number }[] };

function planLines<T extends TransferItemState>(
  items: T[],
  lines: TransferLineInput[] | undefined,
  limit: (item: T) => number,
  what: string,
): Plan<T> | { error: string } {
  const byId = new Map(items.map((i) => [i.id, i]));
  // No lines given: everything that is still possible
  const requested =
    lines ?? items.map((item) => ({ itemId: item.id, quantity: limit(item) }));
  const seen = new Set<string>();
  const planned: Plan<T>['lines'] = [];
  for (const line of requested) {
    const item = byId.get(line.itemId);
    if (!item) return { error: 'A line is not on this transfer' };
    if (seen.has(item.id)) {
      return { error: 'Each transfer line can only appear once' };
    }
    seen.add(item.id);
    if (!isQuantityValue(line.quantity)) {
      return { error: 'Quantities must be 0 or more, with at most 4 decimals' };
    }
    if (line.quantity > limit(item)) {
      return {
        error: `Only ${limit(item)} unit(s) can be ${what} on a line (${line.quantity} given)`,
      };
    }
    if (line.quantity > 0) planned.push({ item, quantity: line.quantity });
  }
  if (planned.length === 0) return { error: `Nothing to be ${what}` };
  return { lines: planned };
}

/**
 * Dispatch (possibly in several goes): up to what is still to send per line
 */
export const planDispatch = <T extends TransferItemState>(
  items: T[],
  lines?: TransferLineInput[],
) => planLines<T>(items, lines, remainingToDispatch, 'dispatched');

/**
 * Receive in good condition only: up to what is still in transit per line.
 * See planReceipt for damaged / missing / over-receipt.
 */
export const planTransferReceipt = <T extends TransferItemState>(
  items: T[],
  lines?: TransferLineInput[],
) => planLines<T>(items, lines, outstandingInTransit, 'received');

/**
 * Write off: dispatched units that will never arrive
 */
export const planWriteOff = <T extends TransferItemState>(
  items: T[],
  lines?: TransferLineInput[],
) => planLines<T>(items, lines, outstandingInTransit, 'written off');

/**
 * Cancel after dispatch: everything still in transit goes back to the source
 */
export function planReturn<T extends TransferItemState>(items: T[]) {
  return items
    .map((item) => ({ item, quantity: outstandingInTransit(item) }))
    .filter((line) => line.quantity > 0);
}

export interface ReceiptLineInput {
  itemId: string;
  // Arrived in good condition
  quantity: number;
  damaged?: number;
  missing?: number;
}

export interface ReceiptPlanLine<T> {
  item: T;
  good: number;
  damaged: number;
  missing: number;
  // Arrived above what was in transit (extra units that left the source)
  over: number;
}

export interface ReceiptPlan<T> {
  lines: ReceiptPlanLine<T>[];
  // Some over-receipt is above the store's tolerance: needs inventory.transfer.approve
  needsApproval: boolean;
}

/**
 * Over-receipt allowed without approval on a line: tolerance % of what was
 * dispatched, minus what was already over-received
 */
export function overReceiptAllowance(
  item: TransferItemState,
  tolerancePercent: number,
): number {
  const dispatched = subQty(
    item.quantityDispatched,
    item.quantityOverReceived ?? 0,
  );
  // Whole units for items sold by the piece; ten-thousandths for measured items
  const raw = (dispatched * Math.max(0, tolerancePercent)) / 100;
  const allowance = Number.isInteger(dispatched)
    ? Math.floor(roundQty(raw))
    : floorQty(raw);
  return Math.max(0, subQty(allowance, item.quantityOverReceived ?? 0));
}

/**
 * Receipt with conditions: good + damaged arrive; missing are reported (they
 * stay in transit). Arriving more than is in transit is an over-receipt,
 * allowed up to the tolerance, above it only with approval.
 */
export function planReceipt<T extends TransferItemState>(
  items: T[],
  lines: ReceiptLineInput[] | undefined,
  tolerancePercent: number,
): ReceiptPlan<T> | { error: string } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const requested: ReceiptLineInput[] =
    lines ??
    items.map((item) => ({
      itemId: item.id,
      quantity: outstandingInTransit(item),
    }));
  const seen = new Set<string>();
  const planned: ReceiptPlanLine<T>[] = [];
  let needsApproval = false;
  for (const line of requested) {
    const item = byId.get(line.itemId);
    if (!item) return { error: 'A line is not on this transfer' };
    if (seen.has(item.id)) {
      return { error: 'Each transfer line can only appear once' };
    }
    seen.add(item.id);
    const good = line.quantity;
    const damaged = line.damaged ?? 0;
    const missing = line.missing ?? 0;
    if ([good, damaged, missing].some((q) => !isQuantityValue(q))) {
      return { error: 'Quantities must be 0 or more, with at most 4 decimals' };
    }
    const outstanding = outstandingInTransit(item);
    const arriving = addQty(good, damaged);
    const over = Math.max(0, subQty(arriving, outstanding));
    if (over > 0 && missing > 0) {
      return {
        error:
          'A line cannot have missing units when more arrived than was sent',
      };
    }
    if (over === 0 && addQty(arriving, missing) > outstanding) {
      return {
        error: `Only ${subQty(outstanding, arriving)} unit(s) can be reported missing on a line (${missing} given)`,
      };
    }
    if (over > overReceiptAllowance(item, tolerancePercent)) {
      needsApproval = true;
    }
    if (addQty(arriving, missing) > 0) {
      planned.push({ item, good, damaged, missing, over });
    }
  }
  if (planned.length === 0) return { error: 'Nothing to be received' };
  return { lines: planned, needsApproval };
}

export const WRITE_OFF_REASON_MAX = 500;

/**
 * A write-off destroys stock value: it must say why (lost, stolen, damaged…)
 */
export function writeOffReasonError(reason: string | null | undefined) {
  const text = reason?.trim() ?? '';
  if (!text) return 'A reason is required to write off units in transit';
  if (text.length > WRITE_OFF_REASON_MAX) {
    return `The reason is too long (${WRITE_OFF_REASON_MAX} characters max)`;
  }
  return null;
}

/**
 * Quantity conservation on a line: dispatched = received + damaged + written
 * off + returned + still in transit, with none of them negative (nothing
 * arrives or is lost twice)
 */
export const isTransferLineBalanced = (item: TransferItemState): boolean =>
  item.quantityReceived >= 0 &&
  item.quantityWrittenOff >= 0 &&
  (item.quantityDamaged ?? 0) >= 0 &&
  (item.quantityReturned ?? 0) >= 0 &&
  outstandingInTransit(item) >= 0;

/**
 * Status of a transfer that has dispatched something. Until the last dispatch
 * (dispatchComplete, or nothing left to send) it is partially dispatched.
 */
export function transferStatus(
  items: TransferItemState[],
  options: { dispatchComplete: boolean },
): StockTransferStatus {
  const moreToSend =
    !options.dispatchComplete && items.some((i) => remainingToDispatch(i) > 0);
  const anyDispatched = items.some((i) => i.quantityDispatched > 0);
  if (!anyDispatched) return StockTransferStatus.APPROVED;
  if (moreToSend) return StockTransferStatus.PARTIALLY_DISPATCHED;
  if (items.every((i) => outstandingInTransit(i) === 0)) {
    return StockTransferStatus.RECEIVED;
  }
  const anyArrived = items.some(
    (i) =>
      i.quantityReceived > 0 ||
      i.quantityWrittenOff > 0 ||
      (i.quantityDamaged ?? 0) > 0,
  );
  return anyArrived
    ? StockTransferStatus.PARTIALLY_RECEIVED
    : StockTransferStatus.IN_TRANSIT;
}

/**
 * Status once dispatched quantities are received / written off, when nothing
 * more will be dispatched
 */
export const statusAfterArrival = (items: TransferItemState[]) =>
  transferStatus(items, { dispatchComplete: true });

export type TransferApprovalMode = 'never' | 'threshold' | 'always';

/**
 * Whether a transfer worth `value` (requested quantities at cost) needs
 * inventory.transfer.approve before it can be dispatched
 */
export function transferNeedsApproval(
  mode: TransferApprovalMode,
  threshold: number,
  value: number,
): boolean {
  if (mode === 'always') return true;
  if (mode === 'threshold') return value > threshold;
  return false;
}

/**
 * Weighted unit cost of a line after another dispatch at `unitCost`
 */
export function dispatchedUnitCost(
  previousQuantity: number,
  previousCost: number | null,
  quantity: number,
  unitCost: number,
): number {
  if (previousQuantity <= 0 || previousCost === null) return unitCost;
  const total = addQty(previousQuantity, quantity);
  return (
    Math.round(
      ((previousQuantity * previousCost + quantity * unitCost) / total) * 10000,
    ) / 10000
  );
}
