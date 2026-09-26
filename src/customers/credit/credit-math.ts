import { round2 } from '../../sales/sale-calculator';

/**
 * Pure customer-account math (D019): FIFO settlement of charges, aging buckets,
 * statements and payment terms. Amounts are money with 2 decimals; every sum is
 * computed in integer cents so nothing drifts.
 */

export const DEFAULT_PAYMENT_TERM_DAYS = 30;

const cents = (value: number) => Math.round(Number(value) * 100);
const fromCents = (value: number) => value / 100;

/** A debit (charge, opening balance, positive adjustment) with what is still open */
export interface OpenDebit {
  id: string;
  open: number;
  // YYYY-MM-DD; null = due at once
  dueDate: string | null;
  createdAt: Date | string;
  saleId?: string | null;
}

/** A credit (payment, credit note, reversal, negative adjustment) not yet applied */
export interface OpenCredit {
  id: string;
  open: number;
  createdAt: Date | string;
  // Settle this debit first (a reversal / credit note of a given charge)
  targetDebitId?: string | null;
}

export interface Allocation {
  debitEntryId: string;
  creditEntryId: string;
  amount: number;
}

const time = (value: Date | string) => new Date(value).getTime();

/**
 * Apply open credits to open debits: a credit tied to a debit settles it first,
 * then everything goes to the oldest due debits (FIFO by due date, then date).
 * Never allocates more than a debit has open or a credit has left.
 */
export function allocateFifo(
  debits: OpenDebit[],
  credits: OpenCredit[],
): Allocation[] {
  const debitLeft = new Map(debits.map((d) => [d.id, cents(d.open)]));
  const ordered = [...debits].sort(
    (a, b) =>
      (a.dueDate ?? '').localeCompare(b.dueDate ?? '') ||
      time(a.createdAt) - time(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  const allocations: Allocation[] = [];
  const give = (debitId: string, creditId: string, left: number): number => {
    const room = debitLeft.get(debitId) ?? 0;
    const amount = Math.min(room, left);
    if (amount <= 0) return left;
    debitLeft.set(debitId, room - amount);
    const existing = allocations.find(
      (a) => a.debitEntryId === debitId && a.creditEntryId === creditId,
    );
    if (existing) existing.amount = round2(existing.amount + fromCents(amount));
    else
      allocations.push({
        debitEntryId: debitId,
        creditEntryId: creditId,
        amount: fromCents(amount),
      });
    return left - amount;
  };

  const creditOrder = [...credits].sort(
    (a, b) =>
      Number(!a.targetDebitId) - Number(!b.targetDebitId) ||
      time(a.createdAt) - time(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
  for (const credit of creditOrder) {
    let left = cents(credit.open);
    if (left <= 0) continue;
    if (credit.targetDebitId && debitLeft.has(credit.targetDebitId)) {
      left = give(credit.targetDebitId, credit.id, left);
    }
    for (const debit of ordered) {
      if (left <= 0) break;
      left = give(debit.id, credit.id, left);
    }
  }
  return allocations;
}

export type AgingBucket =
  'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';

export const AGING_BUCKETS: readonly AgingBucket[] = [
  'current',
  'd1_30',
  'd31_60',
  'd61_90',
  'd90_plus',
];

export type Aging = Record<AgingBucket, number> & { total: number };

/** YYYY-MM-DD of a date (UTC) */
export const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Whole days an amount due on `dueDate` is late on `asOf` (0 or less: not late) */
export function daysPastDue(dueDate: string | null, asOf: Date): number {
  if (!dueDate) return 0;
  const due = Date.UTC(
    Number(dueDate.slice(0, 4)),
    Number(dueDate.slice(5, 7)) - 1,
    Number(dueDate.slice(8, 10)),
  );
  const day = Date.UTC(
    asOf.getUTCFullYear(),
    asOf.getUTCMonth(),
    asOf.getUTCDate(),
  );
  return Math.round((day - due) / 86_400_000);
}

export function bucketOf(days: number): AgingBucket {
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
}

/**
 * Open debits by how late they are: current (not yet due), 1–30, 31–60, 61–90
 * and 90+ days past due. Unapplied credits (the customer paid ahead) reduce the
 * total but no bucket, so `total` equals the account balance.
 */
export function agingOf(
  debits: Pick<OpenDebit, 'open' | 'dueDate'>[],
  asOf: Date,
  unappliedCredit = 0,
): Aging {
  const sums: Record<AgingBucket, number> = {
    current: 0,
    d1_30: 0,
    d31_60: 0,
    d61_90: 0,
    d90_plus: 0,
  };
  for (const debit of debits) {
    const open = cents(debit.open);
    if (open <= 0) continue;
    sums[bucketOf(daysPastDue(debit.dueDate, asOf))] += open;
  }
  const total =
    Object.values(sums).reduce((a, b) => a + b, 0) - cents(unappliedCredit);
  return {
    current: fromCents(sums.current),
    d1_30: fromCents(sums.d1_30),
    d31_60: fromCents(sums.d31_60),
    d61_90: fromCents(sums.d61_90),
    d90_plus: fromCents(sums.d90_plus),
    total: fromCents(total),
  };
}

/** Add aging rows (all customers) */
export function sumAging(rows: Aging[]): Aging {
  const total: Aging = {
    current: 0,
    d1_30: 0,
    d31_60: 0,
    d61_90: 0,
    d90_plus: 0,
    total: 0,
  };
  for (const key of [...AGING_BUCKETS, 'total'] as const) {
    total[key] = fromCents(rows.reduce((a, r) => a + cents(r[key]), 0));
  }
  return total;
}

/** Sum of signed ledger amounts, exactly */
export const ledgerSum = (amounts: (number | string)[]) =>
  fromCents(amounts.reduce<number>((a, v) => a + cents(Number(v)), 0));

/** Due date of a charge made on `date` with `termDays` of credit */
export function dueDateFor(date: Date, termDays: number): string {
  const due = new Date(date.getTime());
  due.setUTCDate(due.getUTCDate() + Math.max(0, Math.floor(termDays)));
  return isoDay(due);
}

/** Payment terms of a customer: their own, else their group's, else the default */
export function paymentTerms(
  customer: { paymentTermDays?: number | null },
  group?: { defaultPaymentTermDays?: number | null } | null,
): number {
  return (
    customer.paymentTermDays ??
    group?.defaultPaymentTermDays ??
    DEFAULT_PAYMENT_TERM_DAYS
  );
}

/** Credit still available (never negative) */
export function availableCredit(creditLimit: number, balance: number): number {
  return Math.max(0, fromCents(cents(creditLimit) - cents(balance)));
}

export interface StatementLine {
  id: string;
  date: Date | string;
  type: string;
  amount: number;
  balance: number;
  reference: string | null;
  note: string | null;
  dueDate: string | null;
}

/**
 * A statement for a period: balance before it, every entry with the running
 * balance, and the closing balance (= opening + sum of the period's entries).
 */
export function buildStatement(
  opening: number,
  entries: {
    id: string;
    createdAt: Date | string;
    type: string;
    amount: number | string;
    paymentRef?: string | null;
    note?: string | null;
    dueDate?: string | null;
  }[],
) {
  let running = cents(opening);
  let charges = 0;
  let credits = 0;
  const lines: StatementLine[] = entries.map((entry) => {
    const amount = cents(Number(entry.amount));
    running += amount;
    if (amount > 0) charges += amount;
    else credits -= amount;
    return {
      id: entry.id,
      date: entry.createdAt,
      type: entry.type,
      amount: fromCents(amount),
      balance: fromCents(running),
      reference: entry.paymentRef ?? null,
      note: entry.note ?? null,
      dueDate: entry.dueDate ?? null,
    };
  });
  return {
    openingBalance: fromCents(cents(opening)),
    totalCharges: fromCents(charges),
    totalCredits: fromCents(credits),
    closingBalance: fromCents(running),
    lines,
  };
}
