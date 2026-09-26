/**
 * Purchase order rules (R071–R073, spec §10). Pure functions, unit tested in
 * purchase-order.logic.spec.ts.
 */
import { PurchaseOrderStatus } from '../database/entities/purchase-order.entity';
import {
  discountedUnitCost,
  fromCents,
  lineAmount,
  percentOf,
  toCents,
} from './money';
import {
  addQty,
  floorQty,
  isQuantityValue,
  roundQty,
  subQty,
} from '../common/utils/quantity';

export type PurchaseOrderAction =
  | 'edit'
  | 'submit'
  | 'approve'
  | 'reject'
  | 'issue'
  | 'receive'
  | 'cancel'
  | 'revise'
  | 'close';

// Which statuses each action is allowed from
export const PO_ALLOWED_FROM: Record<
  PurchaseOrderAction,
  readonly PurchaseOrderStatus[]
> = {
  edit: [PurchaseOrderStatus.DRAFT],
  submit: [PurchaseOrderStatus.DRAFT],
  approve: [PurchaseOrderStatus.PENDING_APPROVAL],
  reject: [PurchaseOrderStatus.PENDING_APPROVAL],
  issue: [PurchaseOrderStatus.APPROVED],
  receive: [PurchaseOrderStatus.ISSUED, PurchaseOrderStatus.PARTIALLY_RECEIVED],
  cancel: [
    PurchaseOrderStatus.DRAFT,
    PurchaseOrderStatus.PENDING_APPROVAL,
    PurchaseOrderStatus.APPROVED,
    PurchaseOrderStatus.ISSUED,
  ],
  // Changing an order after approval records a revision
  revise: [
    PurchaseOrderStatus.APPROVED,
    PurchaseOrderStatus.ISSUED,
    PurchaseOrderStatus.PARTIALLY_RECEIVED,
  ],
  // Short-close (partly received) or close a fully received order
  close: [PurchaseOrderStatus.PARTIALLY_RECEIVED, PurchaseOrderStatus.RECEIVED],
};

export function canTransition(
  status: PurchaseOrderStatus,
  action: PurchaseOrderAction,
): boolean {
  return PO_ALLOWED_FROM[action].includes(status);
}

/**
 * Error message when `action` is not allowed, else null
 */
export function transitionError(
  status: PurchaseOrderStatus,
  action: PurchaseOrderAction,
): string | null {
  if (canTransition(status, action)) return null;
  return `A ${status.replace('_', ' ')} purchase order cannot be ${
    {
      edit: 'edited',
      submit: 'submitted',
      approve: 'approved',
      reject: 'rejected',
      issue: 'issued',
      receive: 'received',
      cancel: 'cancelled',
      revise: 'revised',
      close: 'closed',
    }[action]
  }`;
}

/**
 * Status after submitting: above the threshold it needs purchasing.approve
 * (threshold 0 = every order with a positive total).
 */
export function statusAfterSubmit(
  total: number,
  approvalThreshold: number,
): PurchaseOrderStatus {
  return total > approvalThreshold
    ? PurchaseOrderStatus.PENDING_APPROVAL
    : PurchaseOrderStatus.APPROVED;
}

export interface OrderLineInput {
  quantityOrdered: number;
  // Before the line discount
  unitCost: number;
  // 0–100
  discountPercent?: number;
  // Tax on the line, as the supplier charges it
  taxAmount?: number;
}

export interface OrderLineTotals {
  // quantity × unit cost − discount
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
}

/**
 * Line and order totals, exact to the cent. subtotal is net of line discounts;
 * taxAmount = line taxes + order-level tax; total = subtotal + tax + shipping.
 */
export function computeOrderTotals(
  lines: OrderLineInput[],
  taxAmount = 0,
  shippingCost = 0,
) {
  const lineResults: OrderLineTotals[] = lines.map((line) => {
    const gross = lineAmount(line.quantityOrdered, line.unitCost);
    const discount = percentOf(gross, line.discountPercent ?? 0);
    const net = fromCents(toCents(gross) - toCents(discount));
    const tax = fromCents(toCents(line.taxAmount ?? 0));
    return {
      subtotal: net,
      discountAmount: discount,
      taxAmount: tax,
      total: fromCents(toCents(net) + toCents(tax)),
    };
  });
  const cents = (pick: (l: OrderLineTotals) => number) =>
    lineResults.reduce((sum, l) => sum + toCents(pick(l)), 0);
  const subtotal = cents((l) => l.subtotal);
  const tax = cents((l) => l.taxAmount) + toCents(taxAmount);
  const shipping = toCents(shippingCost);
  return {
    lines: lineResults,
    lineTotals: lineResults.map((l) => l.total),
    subtotal: fromCents(subtotal),
    discountAmount: fromCents(cents((l) => l.discountAmount)),
    taxAmount: fromCents(tax),
    shippingCost: fromCents(shipping),
    total: fromCents(subtotal + tax + shipping),
  };
}

/** Cost of one unit into stock: the order price after the line discount */
export const netUnitCost = (item: {
  unitCost: number;
  discountPercent?: number | null;
}): number =>
  discountedUnitCost(Number(item.unitCost), Number(item.discountPercent ?? 0));

export interface OrderItemState {
  id: string;
  variantId: string;
  quantityOrdered: number;
  quantityReceived: number;
  quantityCancelled?: number;
  // Net unit cost (after the line discount)
  unitCost: number;
}

/** Units still expected on a line */
export const outstandingQuantity = (
  item: Pick<
    OrderItemState,
    'quantityOrdered' | 'quantityReceived' | 'quantityCancelled'
  >,
): number =>
  Math.max(
    0,
    subQty(
      item.quantityOrdered,
      addQty(item.quantityCancelled ?? 0, item.quantityReceived),
    ),
  );

/**
 * Most units a line may have received in total without purchasing.approve:
 * the expected quantity plus the over-receipt tolerance (% of ordered, rounded down)
 */
export const maxReceivableWithinTolerance = (
  item: Pick<OrderItemState, 'quantityOrdered' | 'quantityCancelled'>,
  tolerancePercent: number,
): number => {
  const raw = (item.quantityOrdered * Math.max(0, tolerancePercent)) / 100;
  // Whole units for pieces; ten-thousandths for measured quantities (kg, m, l)
  const tolerance = Number.isInteger(Number(item.quantityOrdered))
    ? Math.floor(roundQty(raw))
    : floorQty(raw);
  return addQty(
    subQty(item.quantityOrdered, item.quantityCancelled ?? 0),
    tolerance,
  );
};

export interface ReceiptLineInput {
  purchaseOrderItemId: string;
  // Units in good condition (go into stock)
  quantity: number;
  // Damaged units: into stock only when accepted, otherwise only recorded
  damagedQuantity?: number;
  damagedAccepted?: boolean;
  unitCost?: number;
}

export interface PlannedReceiptLine {
  item: OrderItemState;
  // Good units
  quantity: number;
  damagedQuantity: number;
  damagedAccepted: boolean;
  // Units that go into stock and count as received on the order
  stockQuantity: number;
  unitCost: number;
}

export interface OverReceipt {
  itemId: string;
  variantId: string;
  // Total received on the line after this receipt
  receivedAfter: number;
  maxWithinTolerance: number;
}

/**
 * Validate a delivery against the order: every line must belong to the order and
 * appear once. Units into stock beyond what is outstanding are an over-receipt:
 * allowed up to the tolerance; lines past it are listed in `overTolerance`
 * (the caller requires purchasing.approve for them).
 */
export function planReceipt(
  items: OrderItemState[],
  lines: ReceiptLineInput[],
  tolerancePercent = 0,
):
  | { lines: PlannedReceiptLine[]; overTolerance: OverReceipt[] }
  | { error: string } {
  const byId = new Map(items.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const planned: PlannedReceiptLine[] = [];
  const overTolerance: OverReceipt[] = [];
  for (const line of lines) {
    const item = byId.get(line.purchaseOrderItemId);
    if (!item) return { error: 'A receipt line is not on this purchase order' };
    if (seen.has(item.id)) {
      return { error: 'Each order line can only appear once per receipt' };
    }
    seen.add(item.id);
    const damaged = line.damagedQuantity ?? 0;
    for (const qty of [line.quantity, damaged]) {
      if (!isQuantityValue(qty)) {
        return {
          error:
            'Received quantities must be 0 or more, with at most 4 decimals',
        };
      }
    }
    if (line.quantity === 0 && damaged === 0) continue;
    const damagedAccepted = damaged > 0 && !!line.damagedAccepted;
    const stockQuantity = addQty(line.quantity, damagedAccepted ? damaged : 0);
    const receivedAfter = addQty(item.quantityReceived, stockQuantity);
    const max = maxReceivableWithinTolerance(item, tolerancePercent);
    if (stockQuantity > 0 && receivedAfter > max) {
      overTolerance.push({
        itemId: item.id,
        variantId: item.variantId,
        receivedAfter,
        maxWithinTolerance: max,
      });
    }
    planned.push({
      item,
      quantity: line.quantity,
      damagedQuantity: damaged,
      damagedAccepted,
      stockQuantity,
      unitCost: line.unitCost ?? item.unitCost,
    });
  }
  if (planned.length === 0) {
    return { error: 'Nothing to receive' };
  }
  return { lines: planned, overTolerance };
}

/**
 * Status once receipts have been applied to the lines
 */
export function statusAfterReceipt(
  items: Pick<
    OrderItemState,
    'quantityOrdered' | 'quantityReceived' | 'quantityCancelled'
  >[],
): PurchaseOrderStatus {
  const complete = items.every((i) => outstandingQuantity(i) === 0);
  if (complete) return PurchaseOrderStatus.RECEIVED;
  return items.some((i) => i.quantityReceived > 0)
    ? PurchaseOrderStatus.PARTIALLY_RECEIVED
    : PurchaseOrderStatus.ISSUED;
}

/**
 * Short-close: cancel what is still outstanding on every line, keeping what was
 * received. Returns the units cancelled per line.
 */
export function planShortClose(
  items: Pick<
    OrderItemState,
    'id' | 'quantityOrdered' | 'quantityReceived' | 'quantityCancelled'
  >[],
): { itemId: string; cancel: number }[] {
  return items
    .map((item) => ({ itemId: item.id, cancel: outstandingQuantity(item) }))
    .filter((c) => c.cancel > 0);
}

// ---- Revisions after approval ----

export interface RevisionLine {
  variantId: string;
  quantityOrdered: number;
}

/**
 * A revision cannot drop a line that already received goods, nor order less
 * than was received
 */
export function revisionError(
  current: {
    variantId: string;
    sku: string;
    quantityReceived: number;
  }[],
  lines: RevisionLine[],
): string | null {
  const next = new Map(lines.map((l) => [l.variantId, l]));
  for (const item of current) {
    if (item.quantityReceived === 0) continue;
    const line = next.get(item.variantId);
    if (!line) {
      return `${item.sku} was already received and cannot be removed from the order`;
    }
    if (line.quantityOrdered < item.quantityReceived) {
      return `${item.sku}: ${item.quantityReceived} unit(s) were already received; order at least that many`;
    }
  }
  return null;
}

/**
 * Status after a revision: back to approval when the new total is above the
 * threshold; otherwise the order keeps its place in the lifecycle.
 */
export function statusAfterRevision(
  before: PurchaseOrderStatus,
  totalAfter: number,
  approvalThreshold: number,
  items: Pick<
    OrderItemState,
    'quantityOrdered' | 'quantityReceived' | 'quantityCancelled'
  >[],
): { status: PurchaseOrderStatus; requiresApproval: boolean } {
  if (totalAfter > approvalThreshold) {
    return {
      status: PurchaseOrderStatus.PENDING_APPROVAL,
      requiresApproval: true,
    };
  }
  if (before === PurchaseOrderStatus.APPROVED) {
    return { status: before, requiresApproval: false };
  }
  return { status: statusAfterReceipt(items), requiresApproval: false };
}
