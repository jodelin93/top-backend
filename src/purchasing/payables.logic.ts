/**
 * Accounts payable rules (spec §10): 3-way match, allocation of payments and
 * credits, supplier returns limits, aging and statements. Pure functions, unit
 * tested in payables.logic.spec.ts. Money is exact to the cent (see ./money).
 */
import { fromCents, lineAmount, percentChange, round4, toCents } from './money';
import { isQuantityValue, subQty } from '../common/utils/quantity';

// ---- 3-way match ----

export interface MatchInput {
  quantity: number;
  unitPrice: number;
  // Net unit cost on the order line
  expectedUnitPrice: number;
  // Received on the order line and not yet invoiced on another invoice
  matchableQuantity: number;
}

export interface MatchResult {
  // (unit price − expected) × quantity
  priceVariance: number;
  // (unit price − expected) ÷ expected, in %; null when expected is 0
  priceVariancePercent: number | null;
  // Invoiced − matchable (positive: billed for more than was received)
  quantityVariance: number;
  // Outside the tolerance: needs purchasing.approve
  flagged: boolean;
  reasons: string[];
}

/**
 * Compare an invoice line with its order line and what was received.
 * Flags a price above the order price by more than `tolerancePercent`, and any
 * quantity billed beyond what was received and not yet invoiced. Paying less
 * than ordered, or for fewer units than received, is never flagged.
 */
export function matchInvoiceLine(
  input: MatchInput,
  tolerancePercent: number,
): MatchResult {
  const priceDiff = round4(input.unitPrice - input.expectedUnitPrice);
  const priceVariance = lineAmount(input.quantity, priceDiff);
  const priceVariancePercent = percentChange(
    input.unitPrice,
    input.expectedUnitPrice,
  );
  const quantityVariance = subQty(input.quantity, input.matchableQuantity);
  const reasons: string[] = [];
  if (
    priceDiff > 0 &&
    (priceVariancePercent === null || priceVariancePercent > tolerancePercent)
  ) {
    reasons.push(
      priceVariancePercent === null
        ? 'Billed a price on a free order line'
        : `Price ${priceVariancePercent}% above the order (tolerance ${tolerancePercent}%)`,
    );
  }
  if (quantityVariance > 0) {
    reasons.push(
      `Billed ${quantityVariance} unit(s) more than received and not yet invoiced`,
    );
  }
  return {
    priceVariance,
    priceVariancePercent,
    quantityVariance,
    flagged: reasons.length > 0,
    reasons,
  };
}

// ---- Allocations ----

export interface AllocationRequest {
  invoiceId: string;
  amount: number;
}

export interface AllocatableInvoice {
  id: string;
  supplierId: string;
  status: string;
  // Total − what is already allocated to it
  openAmount: number;
}

/**
 * Check allocations of one payment / credit: each amount positive, to an open
 * invoice of the same supplier, never more than the invoice still owes nor, in
 * total, more than the payment / credit has left. Returns an error or null.
 */
export function allocationError(options: {
  supplierId: string;
  // Payment / credit amount not yet allocated
  available: number;
  invoices: Map<string, AllocatableInvoice>;
  requests: AllocationRequest[];
}): string | null {
  const { supplierId, available, invoices, requests } = options;
  const perInvoice = new Map<string, number>();
  let totalCents = 0;
  for (const request of requests) {
    const cents = toCents(request.amount);
    if (cents <= 0) return 'Allocated amounts must be positive';
    const invoice = invoices.get(request.invoiceId);
    if (!invoice || invoice.supplierId !== supplierId) {
      return 'An allocation is for an invoice of another supplier';
    }
    if (invoice.status !== 'open') {
      return 'Only approved (open) invoices can be paid';
    }
    const invoiceCents = (perInvoice.get(invoice.id) ?? 0) + cents;
    perInvoice.set(invoice.id, invoiceCents);
    if (invoiceCents > toCents(invoice.openAmount)) {
      return `Only ${fromCents(toCents(invoice.openAmount)).toFixed(2)} is still owed on an invoice`;
    }
    totalCents += cents;
  }
  if (totalCents > toCents(available)) {
    return `Only ${fromCents(toCents(available)).toFixed(2)} is left to allocate`;
  }
  return null;
}

/**
 * Spread `amount` over invoices, oldest due first, never more than each owes
 * (used to prefill a payment)
 */
export function autoAllocate(
  amount: number,
  invoices: { id: string; dueDate: string; openAmount: number }[],
): AllocationRequest[] {
  let left = toCents(amount);
  const result: AllocationRequest[] = [];
  for (const invoice of [...invoices].sort((a, b) =>
    a.dueDate.localeCompare(b.dueDate),
  )) {
    if (left <= 0) break;
    const take = Math.min(left, toCents(invoice.openAmount));
    if (take <= 0) continue;
    result.push({ invoiceId: invoice.id, amount: fromCents(take) });
    left -= take;
  }
  return result;
}

// ---- Supplier returns ----

export interface ReturnableReceiptLine {
  id: string;
  variantId: string;
  // Units received on the line
  quantity: number;
  // Only units that went into stock can be returned
  accepted: boolean;
  quantityReturned: number;
  unitCost: number;
}

export interface PlannedReturnLine {
  line: ReturnableReceiptLine;
  quantity: number;
  total: number;
}

/**
 * Validate a return against a receipt: each line at most once, quantities ≤
 * received − already returned (rejected damaged units never went into stock).
 */
export function planSupplierReturn(
  receiptLines: ReturnableReceiptLine[],
  requests: { receiptItemId: string; quantity: number }[],
): { lines: PlannedReturnLine[]; total: number } | { error: string } {
  const byId = new Map(receiptLines.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const lines: PlannedReturnLine[] = [];
  for (const request of requests) {
    const line = byId.get(request.receiptItemId);
    if (!line) return { error: 'A return line is not on this receipt' };
    if (seen.has(line.id)) {
      return { error: 'Each receipt line can only appear once per return' };
    }
    seen.add(line.id);
    if (!isQuantityValue(request.quantity)) {
      return {
        error: 'Returned quantities must be 0 or more, with at most 4 decimals',
      };
    }
    if (request.quantity === 0) continue;
    const returnable = line.accepted
      ? subQty(line.quantity, line.quantityReturned)
      : 0;
    if (request.quantity > returnable) {
      return {
        error: `Only ${returnable} unit(s) of a receipt line can still be returned (${request.quantity} requested)`,
      };
    }
    lines.push({
      line,
      quantity: request.quantity,
      total: lineAmount(request.quantity, line.unitCost),
    });
  }
  if (lines.length === 0) return { error: 'Nothing to return' };
  return {
    lines,
    total: fromCents(lines.reduce((sum, l) => sum + toCents(l.total), 0)),
  };
}

// ---- Dates ----

const DAY_MS = 86_400_000;
const utcDay = (date: string): number => {
  const [y, m, d] = date.slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};

/** YYYY-MM-DD of a Date (UTC) */
export const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

/** date + days, as YYYY-MM-DD */
export const addDays = (date: string, days: number): string =>
  isoDate(new Date(utcDay(date) + days * DAY_MS));

/** Whole days from `from` to `to` (negative when `to` is earlier) */
export const daysBetween = (from: string, to: string): number =>
  Math.round((utcDay(to) - utcDay(from)) / DAY_MS);

// ---- Aging ----

export type AgingBucket =
  'current' | 'days1to30' | 'days31to60' | 'days61to90' | 'over90';

export const AGING_BUCKETS: AgingBucket[] = [
  'current',
  'days1to30',
  'days31to60',
  'days61to90',
  'over90',
];

/** Bucket of an amount due on `dueDate`, seen on `asOf` (not yet due = current) */
export function agingBucket(dueDate: string, asOf: string): AgingBucket {
  const overdue = daysBetween(dueDate, asOf);
  if (overdue <= 0) return 'current';
  if (overdue <= 30) return 'days1to30';
  if (overdue <= 60) return 'days31to60';
  if (overdue <= 90) return 'days61to90';
  return 'over90';
}

export interface AgingInvoice {
  dueDate: string;
  total: number;
  // Payments + credits allocated to it
  allocated: number;
}

export type AgingResult = Record<AgingBucket, number> & {
  // Payments and credits not yet allocated to an invoice (reduce the balance)
  unapplied: number;
  // Owed on invoices − unapplied
  balance: number;
};

/**
 * Aging of one supplier: what is still owed on each invoice, by how overdue it
 * is, and the balance (invoices − payments − credits, all derived).
 */
export function computeAging(
  invoices: AgingInvoice[],
  unapplied: number,
  asOf: string,
): AgingResult {
  const cents: Record<AgingBucket, number> = {
    current: 0,
    days1to30: 0,
    days31to60: 0,
    days61to90: 0,
    over90: 0,
  };
  for (const invoice of invoices) {
    const open = toCents(invoice.total) - toCents(invoice.allocated);
    if (open <= 0) continue;
    cents[agingBucket(invoice.dueDate, asOf)] += open;
  }
  const owed = AGING_BUCKETS.reduce((sum, b) => sum + cents[b], 0);
  return {
    current: fromCents(cents.current),
    days1to30: fromCents(cents.days1to30),
    days31to60: fromCents(cents.days31to60),
    days61to90: fromCents(cents.days61to90),
    over90: fromCents(cents.over90),
    unapplied: fromCents(toCents(unapplied)),
    balance: fromCents(owed - toCents(unapplied)),
  };
}

// ---- Statement ----

export interface StatementEntry {
  date: string;
  type: 'invoice' | 'credit' | 'payment';
  id: string;
  number: string;
  description: string;
  // Invoices increase what is owed; credits and payments reduce it
  amount: number;
}

export interface StatementLine extends StatementEntry {
  debit: number;
  credit: number;
  balance: number;
}

/**
 * Chronological statement from `from` to `to` (inclusive): opening balance
 * (everything before `from`), each document with the running balance, closing
 * balance
 */
export function buildStatement(
  entries: StatementEntry[],
  from: string,
  to: string,
): { openingBalance: number; lines: StatementLine[]; closingBalance: number } {
  const sign = (e: StatementEntry) => (e.type === 'invoice' ? 1 : -1);
  const order: Record<StatementEntry['type'], number> = {
    invoice: 0,
    credit: 1,
    payment: 2,
  };
  const sorted = [...entries].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      order[a.type] - order[b.type] ||
      a.number.localeCompare(b.number),
  );
  let openingCents = 0;
  let running = 0;
  const lines: StatementLine[] = [];
  for (const entry of sorted) {
    if (entry.date > to) continue;
    const cents = sign(entry) * toCents(entry.amount);
    running += cents;
    if (entry.date < from) {
      openingCents = running;
      continue;
    }
    lines.push({
      ...entry,
      debit: cents > 0 ? fromCents(cents) : 0,
      credit: cents < 0 ? fromCents(-cents) : 0,
      balance: fromCents(running),
    });
  }
  return {
    openingBalance: fromCents(openingCents),
    lines,
    closingBalance: fromCents(running),
  };
}
