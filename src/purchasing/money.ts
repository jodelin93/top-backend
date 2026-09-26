/**
 * Exact money arithmetic for purchasing. Amounts are handled as integer cents,
 * unit costs and percentages as integers scaled by 10,000 (4 decimals, as
 * stored in numeric(19,4)); products go through BigInt. Results are plain
 * numbers with 2 decimals (amounts) or 4 decimals (unit costs). Same approach
 * as the sale calculator (see src/sales/sale-calculator.ts, round2).
 */
import { round2 } from '../sales/sale-calculator';

export { round2 };

const SCALE4 = 10_000;

/** Integer value of a decimal with at most 4 fraction digits, times `scale` */
const scaled = (value: number, scale: number): number =>
  Math.round(Number((Number(value) * scale).toPrecision(15)));

export const toCents = (value: number): number => scaled(value, 100);
export const fromCents = (cents: number): number => cents / 100;

/** round(a × b ÷ d), half away from zero, computed exactly */
function mulDiv(a: number, b: number, d: number): number {
  const numerator = BigInt(a) * BigInt(b);
  const divisor = BigInt(d);
  const quotient = numerator / divisor;
  const remainder = numerator % divisor;
  const absRemainder = remainder < BigInt(0) ? -remainder : remainder;
  const roundUp = absRemainder * BigInt(2) >= divisor;
  const sign = numerator < BigInt(0) ? -1 : 1;
  return Number(quotient) + (roundUp ? sign : 0);
}

/** Round to 4 decimals (unit costs) */
export const round4 = (value: number): number => scaled(value, SCALE4) / SCALE4;

/** Sum of amounts, exact to the cent */
export const sumMoney = (values: number[]): number =>
  fromCents(values.reduce((sum, v) => sum + toCents(v), 0));

/** a − b, exact to the cent */
export const subMoney = (a: number, b: number): number =>
  fromCents(toCents(a) - toCents(b));

/**
 * quantity × unit cost (both up to 4 decimals: measured items are bought by the
 * kg / m / l), rounded to the cent
 */
export const lineAmount = (quantity: number, unitCost: number): number =>
  fromCents(
    mulDiv(
      scaled(quantity, SCALE4),
      scaled(unitCost, SCALE4),
      (SCALE4 * SCALE4) / 100,
    ),
  );

/** pct % of an amount, rounded to the cent (pct may have 4 decimals) */
export const percentOf = (amount: number, pct: number): number =>
  fromCents(mulDiv(toCents(amount), scaled(pct, SCALE4), 100 * SCALE4));

/** Unit cost after a line discount, to 4 decimals */
export const discountedUnitCost = (unitCost: number, pct: number): number =>
  mulDiv(
    scaled(unitCost, SCALE4),
    100 * SCALE4 - scaled(pct, SCALE4),
    100 * SCALE4,
  ) / SCALE4;

/** (a − b) ÷ b in percent, to 4 decimals; null when b is 0 */
export const percentChange = (a: number, b: number): number | null => {
  const base = scaled(b, SCALE4);
  if (base === 0) return null;
  return mulDiv(scaled(a, SCALE4) - base, 100 * SCALE4, base) / SCALE4;
};
