import { BadRequestException } from '@nestjs/common';
import { round2 } from '../sales/sale-calculator';
import type { DenominationCount } from '../database/entities/shift.entity';
import { CashMovementType } from '../database/entities/cash-movement.entity';

/**
 * Pure cash-drawer arithmetic (no I/O) so it can be unit tested.
 */

// Notes and coins by currency, largest first. Stores can override per currency.
export const DEFAULT_DENOMINATIONS: Record<string, number[]> = {
  USD: [100, 50, 20, 10, 5, 2, 1, 0.25, 0.1, 0.05, 0.01],
  EUR: [500, 200, 100, 50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01],
  CAD: [100, 50, 20, 10, 5, 2, 1, 0.25, 0.1, 0.05],
  GBP: [50, 20, 10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01],
  HTG: [1000, 500, 250, 100, 50, 25, 10, 5, 1, 0.5],
};

// Used for currencies without defaults
export const GENERIC_DENOMINATIONS = [100, 50, 20, 10, 5, 2, 1, 0.5, 0.1];

export function defaultDenominations(currencyCode: string): number[] {
  return (
    DEFAULT_DENOMINATIONS[currencyCode.toUpperCase()] ?? GENERIC_DENOMINATIONS
  );
}

/** Deduplicate, validate and sort a denomination list (largest first) */
export function normalizeDenominations(values: number[]): number[] {
  const cleaned = values.map((v) => round2(Number(v)));
  if (cleaned.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new BadRequestException('Denominations must be positive amounts');
  }
  return [...new Set(cleaned)].sort((a, b) => b - a);
}

/** Total of a denomination count. Quantities must be whole, non-negative numbers. */
export function countTotal(counts: DenominationCount[]): number {
  let total = 0;
  for (const { value, quantity } of counts) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new BadRequestException('Denomination values must be positive');
    }
    if (!Number.isInteger(quantity) || quantity < 0) {
      throw new BadRequestException(
        'Denomination quantities must be whole numbers of 0 or more',
      );
    }
    total += round2(value) * quantity;
  }
  return round2(total);
}

/** Everything that moved cash in or out of the drawer during a shift */
export interface CashBreakdown {
  openingFloat: number;
  // Cash tendered on completed sales (before change)
  cashSales: number;
  // Change handed back on those sales
  changeGiven: number;
  paidIn: number;
  paidOut: number;
  safeDrops: number;
  expensePayouts: number;
  cashRefunds: number;
  // Cash taken in other currencies (the drawer holds each currency separately)
  foreign: ForeignCashBreakdown[];
}

export interface ForeignCashBreakdown {
  currencyCode: string;
  // In the drawer at opening (carried over by a handover)
  openingFloat?: number;
  // Tendered in this currency on completed sales, before change
  cashSales: number;
  // Change handed back in this currency
  changeGiven: number;
  // Paid-in, paid-out and safe drops made in this currency
  paidIn?: number;
  paidOut?: number;
  safeDrops?: number;
  // Cash refunds handed back in this currency (money that was paid in it)
  cashRefunds?: number;
  // Expenses paid from the drawer in this currency
  expensePayouts?: number;
  expected: number;
}

export interface ForeignCashResult {
  currencyCode: string;
  expected: number;
  counted: number;
  variance: number;
  // Units per 1 unit of the store currency, used to weigh the variance
  exchangeRate: number | null;
  overTolerance: boolean;
}

/**
 * Add the foreign cash the shift opened with (typed at opening or a handover) and
 * the paid-ins, paid-outs, safe drops and cash refunds made in each currency to what its sales
 * took: expected = opening + tendered − change + paid in − paid out − safe drops,
 * per currency. A currency with only an opening float or a movement is listed too,
 * so it must be counted at close.
 */
export function withOpeningForeign(
  foreign: ForeignCashBreakdown[],
  opening: { currencyCode: string; amount: number }[] | null | undefined,
  movements: { currencyCode: string; type: string; amount: number }[] = [],
): ForeignCashBreakdown[] {
  type Row = ForeignCashBreakdown &
    Required<
      Pick<
        ForeignCashBreakdown,
        | 'openingFloat'
        | 'paidIn'
        | 'paidOut'
        | 'safeDrops'
        | 'cashRefunds'
        | 'expensePayouts'
      >
    >;
  const byCode = new Map<string, Row>(
    foreign.map((f) => [
      f.currencyCode,
      {
        ...f,
        openingFloat: 0,
        paidIn: 0,
        paidOut: 0,
        safeDrops: 0,
        cashRefunds: 0,
        expensePayouts: 0,
      },
    ]),
  );
  const rowFor = (code: string): Row => {
    let row = byCode.get(code);
    if (!row) {
      row = {
        currencyCode: code,
        openingFloat: 0,
        cashSales: 0,
        changeGiven: 0,
        paidIn: 0,
        paidOut: 0,
        safeDrops: 0,
        cashRefunds: 0,
        expensePayouts: 0,
        expected: 0,
      };
      byCode.set(code, row);
    }
    return row;
  };
  for (const o of opening ?? []) {
    const amount = round2(Number(o.amount) || 0);
    if (amount <= 0) continue;
    const row = rowFor(o.currencyCode.toUpperCase());
    row.openingFloat = round2(row.openingFloat + amount);
  }
  const FIELD: Partial<
    Record<
      string,
      'paidIn' | 'paidOut' | 'safeDrops' | 'cashRefunds' | 'expensePayouts'
    >
  > = {
    [CashMovementType.PAID_IN]: 'paidIn',
    [CashMovementType.PAID_OUT]: 'paidOut',
    [CashMovementType.SAFE_DROP]: 'safeDrops',
    [CashMovementType.REFUND]: 'cashRefunds',
    [CashMovementType.EXPENSE]: 'expensePayouts',
  };
  for (const m of movements) {
    const field = FIELD[m.type];
    const amount = round2(Number(m.amount) || 0);
    if (!field || amount <= 0 || !m.currencyCode) continue;
    const row = rowFor(m.currencyCode.toUpperCase());
    row[field] = round2(row[field] + amount);
  }
  return [...byCode.values()]
    .map((f) => ({
      ...f,
      expected: round2(
        f.openingFloat +
          f.cashSales -
          f.changeGiven +
          f.paidIn -
          f.paidOut -
          f.safeDrops -
          f.cashRefunds -
          f.expensePayouts,
      ),
    }))
    .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
}

/**
 * Currency of a paid-in / paid-out / safe drop: null for the shift's currency,
 * else an accepted currency (one with an exchange rate).
 */
export function movementCurrency(
  requested: string | undefined,
  shiftCurrency: string,
  exchangeRates: Record<string, number> | null | undefined,
): string | null {
  if (!requested) return null;
  const code = requested.toUpperCase();
  if (code === shiftCurrency.trim().toUpperCase()) return null;
  const accepted = Object.keys(exchangeRates ?? {}).map((c) => c.toUpperCase());
  if (!accepted.includes(code)) {
    throw new BadRequestException(
      `${code} is not a currency this store accepts`,
    );
  }
  return code;
}

/**
 * Counted vs expected for each foreign currency in the drawer. Every currency the
 * shift took must be counted. A variance is over tolerance when its value in the
 * store currency is (unknown rate: any variance).
 */
export function evaluateForeignCash(
  foreign: ForeignCashBreakdown[],
  counts: { currencyCode: string; countedCash: number }[] | undefined,
  rateOf: (currencyCode: string) => number | null,
  tolerance: number,
): ForeignCashResult[] {
  const byCode = new Map(
    (counts ?? []).map((c) => [c.currencyCode.toUpperCase(), c.countedCash]),
  );
  const tol = Math.max(0, round2(Number(tolerance) || 0));
  return foreign.map((f) => {
    const counted = byCode.get(f.currencyCode);
    if (counted === undefined) {
      throw new BadRequestException(
        `Count the ${f.currencyCode} cash in the drawer too`,
      );
    }
    if (!Number.isFinite(counted) || counted < 0) {
      throw new BadRequestException(
        `The counted ${f.currencyCode} cash must be 0 or more`,
      );
    }
    const variance = round2(counted - f.expected);
    const rate = rateOf(f.currencyCode);
    const inStoreCurrency = rate
      ? Math.abs(variance) / rate
      : Math.abs(variance);
    return {
      currencyCode: f.currencyCode,
      expected: round2(f.expected),
      counted: round2(counted),
      variance,
      exchangeRate: rate,
      overTolerance: Math.round(inStoreCurrency * 100) > Math.round(tol * 100),
    };
  });
}

/**
 * Expected drawer cash (R104):
 * float + cash sales − change + paid-in − paid-out − safe drops − expense payouts − cash refunds
 */
export function expectedCash(b: CashBreakdown): number {
  return round2(
    b.openingFloat +
      b.cashSales -
      b.changeGiven +
      b.paidIn -
      b.paidOut -
      b.safeDrops -
      b.expensePayouts -
      b.cashRefunds,
  );
}

export interface VarianceResult {
  counted: number;
  expected: number;
  // counted − expected: negative = drawer is short, positive = over
  variance: number;
  tolerance: number;
  overTolerance: boolean;
}

export function evaluateVariance(
  counted: number,
  expected: number,
  tolerance: number,
): VarianceResult {
  const variance = round2(counted - expected);
  const tol = Math.max(0, round2(Number(tolerance) || 0));
  return {
    counted: round2(counted),
    expected: round2(expected),
    variance,
    tolerance: tol,
    // Compare in cents to avoid floating point noise
    overTolerance: Math.round(Math.abs(variance) * 100) > Math.round(tol * 100),
  };
}

export interface CloseAuthorityInput {
  overTolerance: boolean;
  varianceReason?: string | null;
  // Closer holds shifts.manage
  closerCanManage: boolean;
  // Approver from a verified X-Approval-Token (always a different person), or null
  approverId: string | null;
  closerId: string;
}

export type CloseAuthorityResult =
  | { ok: true; approverId: string | null }
  | {
      ok: false;
      code: 'reason_required' | 'approval_required';
      message: string;
    };

/**
 * Over-tolerance variances need a reason and either the shifts.manage permission
 * or a manager approval from someone other than the closer.
 */
export function checkCloseAuthority(
  input: CloseAuthorityInput,
): CloseAuthorityResult {
  if (!input.overTolerance) {
    return { ok: true, approverId: null };
  }
  if (!input.varianceReason?.trim()) {
    return {
      ok: false,
      code: 'reason_required',
      message: 'The variance is above the tolerance: enter a reason',
    };
  }
  if (input.closerCanManage) {
    return { ok: true, approverId: null };
  }
  if (input.approverId && input.approverId !== input.closerId) {
    return { ok: true, approverId: input.approverId };
  }
  return {
    ok: false,
    code: 'approval_required',
    message:
      'The variance is above the tolerance: a manager must approve closing this shift',
  };
}

/**
 * Foreign cash typed at opening: accepted currencies only (those with an exchange
 * rate, never the store currency), one entry per currency, zero amounts dropped.
 */
export function foreignOpeningFloats(
  input: { currencyCode: string; amount: number }[] | undefined,
  storeCurrency: string,
  exchangeRates: Record<string, number> | null | undefined,
): { currencyCode: string; amount: number }[] {
  const accepted = new Set(
    Object.keys(exchangeRates ?? {}).map((c) => c.toUpperCase()),
  );
  const byCode = new Map<string, number>();
  for (const entry of input ?? []) {
    const code = entry.currencyCode.toUpperCase();
    if (code === storeCurrency.toUpperCase() || !accepted.has(code)) {
      throw new BadRequestException(
        `${code} is not a currency this store accepts`,
      );
    }
    if (byCode.has(code)) {
      throw new BadRequestException(`${code} is listed twice`);
    }
    byCode.set(code, round2(entry.amount));
  }
  return [...byCode]
    .filter(([, amount]) => amount > 0)
    .map(([currencyCode, amount]) => ({ currencyCode, amount }));
}
