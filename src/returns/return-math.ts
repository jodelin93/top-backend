import { round2 } from '../sales/sale-calculator';
import { qtyUnits } from '../common/utils/quantity';

export interface SaleLineAmounts {
  quantity: number;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
}

export interface LineRefund {
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
}

/**
 * What returning `quantity` more units of a sale line refunds, given `alreadyReturned`.
 *
 * Uses the amounts recorded on the original sale (price, discount and tax snapshot),
 * spread evenly per unit. Each amount is computed cumulatively —
 * round(amount × returnedAfter / qty) − round(amount × returnedBefore / qty) —
 * so any number of partial returns adds up to exactly the original line, never a
 * cent more or less. Quantities may be decimal (measured items: 0.5 kg of a
 * 1.25 kg line); the proration is exact (integer cents and ten-thousandths).
 */
export function lineRefund(
  line: SaleLineAmounts,
  alreadyReturned: number,
  quantity: number,
): LineRefund {
  const sold = qtyUnits(line.quantity);
  const before = qtyUnits(alreadyReturned);
  const after = before + qtyUnits(quantity);
  if (quantity <= 0 || alreadyReturned < 0 || after > sold || sold <= 0) {
    throw new RangeError('Return quantity is out of range for this line');
  }
  const share = (amount: number) => {
    const cents = Math.round(Number((Number(amount) * 100).toPrecision(15)));
    return (
      (proratedCents(cents, after, sold) - proratedCents(cents, before, sold)) /
      100
    );
  };
  return {
    subtotal: share(line.subtotal),
    discountAmount: share(line.discountAmount),
    taxAmount: share(line.taxAmount),
    total: share(line.total),
  };
}

/** round(cents × part ÷ whole), half away from zero, exactly (BigInt) */
function proratedCents(cents: number, part: number, whole: number): number {
  const numerator = BigInt(cents) * BigInt(part);
  const divisor = BigInt(whole);
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  const absRemainder = remainder < BigInt(0) ? -remainder : remainder;
  const roundUp = absRemainder * BigInt(2) >= divisor;
  const sign = numerator < BigInt(0) ? -1 : 1;
  return Number(quotient) + (roundUp ? sign : 0);
}

export interface RefundablePayment {
  paymentId: string;
  paymentMethodId: string;
  isCash: boolean;
  // Paid on the original sale (cash: net of change given)
  amount: number;
  // Already refunded to this payment by earlier returns
  refunded: number;
}

export interface RefundAllocation {
  paymentId: string;
  paymentMethodId: string;
  amount: number;
}

/**
 * Default refund split: back to the original tenders, non-cash first (so card
 * customers get their money back on the card), then cash. Never more than each
 * payment still has left to refund.
 */
export function allocateToOriginalTenders(
  total: number,
  payments: RefundablePayment[],
): RefundAllocation[] {
  let remaining = round2(total);
  const ordered = [...payments].sort(
    (a, b) => Number(a.isCash) - Number(b.isCash),
  );
  const allocations: RefundAllocation[] = [];
  for (const payment of ordered) {
    if (remaining <= 0) break;
    const available = round2(payment.amount - payment.refunded);
    const amount = round2(Math.min(available, remaining));
    if (amount > 0) {
      allocations.push({
        paymentId: payment.paymentId,
        paymentMethodId: payment.paymentMethodId,
        amount,
      });
      remaining = round2(remaining - amount);
    }
  }
  if (remaining > 0) {
    throw new RangeError('The original payments do not cover this refund');
  }
  return allocations;
}

/**
 * Share of a return to take off the customer's account when the sale was
 * (partly) paid on account: proportional to what went on account, computed on
 * everything refunded so far so partial returns add up exactly. Never more than
 * the account still carries for the sale, nor than this refund.
 */
export function onAccountShare(input: {
  saleTotal: number;
  paidOnAccount: number;
  // Already credited back to the account for this sale
  creditedSoFar: number;
  // All refunds of the sale so far (any tender)
  refundedSoFar: number;
  refund: number;
}): number {
  const cents = (v: number) => Math.round(v * 100);
  const saleTotal = cents(input.saleTotal);
  if (saleTotal <= 0) return 0;
  const cumulative = cents(input.refundedSoFar) + cents(input.refund);
  const target =
    Math.round((cumulative * cents(input.paidOnAccount)) / saleTotal) -
    cents(input.creditedSoFar);
  const room = cents(input.paidOnAccount) - cents(input.creditedSoFar);
  return Math.max(0, Math.min(target, room, cents(input.refund))) / 100;
}

/**
 * Age of a sale in days for the return window. The sale date comes from the
 * till (offline sales, a skewed clock) and could be set in the future to keep a
 * sale returnable forever: a sale can't be younger than when the server
 * recorded it (createdAt), so the window runs from the earlier of the two, and
 * the age is never negative.
 */
export function saleAgeDays(
  sale: { saleDate: Date | string; createdAt?: Date | string | null },
  now = Date.now(),
): number {
  const times = [sale.saleDate, sale.createdAt]
    .filter((t): t is Date | string => t !== null && t !== undefined)
    .map((t) => new Date(t).getTime())
    .filter((t) => Number.isFinite(t));
  // Neither date readable: treat as old (the window check then asks a manager)
  if (!times.length) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now - Math.min(...times)) / 86_400_000);
}
