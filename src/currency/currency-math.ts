/**
 * Multi-currency arithmetic, shared byte-for-byte with the frontend
 * (top-frontend/src/lib/pos/currency-math.ts; a test enforces it).
 *
 * Sales are priced in the store currency. Customers may also pay in the other
 * currencies of `exchangeRates`, where each rate is how many units of that currency
 * one unit of the store currency buys (e.g. { HTG: 132.5 } for 1 USD = 132.50 HTG).
 */

export type ExchangeRates = Record<string, number>;

// Exact for decimal inputs (1.005 → 1.01), unlike Math.round(value * 100)
const cents = (value: number) =>
  (Math.sign(value) *
    Math.round(Number((Math.abs(value) * 100).toPrecision(15)))) /
  100;

/** Units of `to` for one unit of `from`, or null when either currency is not accepted */
export function exchangeRate(
  rates: ExchangeRates | null | undefined,
  storeCurrency: string,
  from: string,
  to: string,
): number | null {
  const perStoreUnit = (code: string) =>
    code === storeCurrency ? 1 : Number(rates?.[code]) || null;
  const fromRate = perStoreUnit(from);
  const toRate = perStoreUnit(to);
  if (!fromRate || !toRate) return null;
  return toRate / fromRate;
}

/** Currencies a customer can pay with: the store currency first */
export function acceptedCurrencies(
  rates: ExchangeRates | null | undefined,
  storeCurrency: string,
): string[] {
  const others = Object.entries(rates ?? {})
    .filter(([code, rate]) => code !== storeCurrency && Number(rate) > 0)
    .map(([code]) => code)
    .sort();
  return [storeCurrency, ...others];
}

/** Sale-currency value of an amount tendered in another currency (unrounded) */
export function toSaleCurrency(tendered: number, rate: number): number {
  return tendered / rate;
}

/** Amount to ask for in another currency: rounded up so it always covers the sale */
export function amountDueIn(saleAmount: number, rate: number): number {
  // The small epsilon keeps float noise (10 × 132.5 = 1325.0000001) from adding a cent
  return cents(Math.ceil(saleAmount * rate * 100 - 1e-6) / 100);
}

/** Change to hand back in another currency: rounded down, never more than owed */
export function changeIn(saleAmount: number, rate: number): number {
  return cents(Math.floor(saleAmount * rate * 100 + 1e-6) / 100);
}
