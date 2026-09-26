/**
 * Weighted / price-embedded barcodes (GS1 variable measure, EAN-13 prefixes 20–29),
 * printed by scales and deli label printers:
 *
 *   PP IIIII VVVVV C
 *   PP     prefix (one of the store's weightedBarcodePrefixes, e.g. 20–29)
 *   IIIII  item code: the PLU stored on the variant (length: itemCodeLength, 5 default)
 *   VVVVV  value: the weight (layout 'weight', 3 decimals: 01250 = 1.250 kg) or the
 *          price (layout 'price', 2 decimals: 00499 = 4.99)
 *   C      EAN-13 check digit (validated)
 *
 * Pure and dependency-free: shared by the API (catalog lookup) and the POS
 * frontend (offline scans).
 */

export type WeightedBarcodeLayout = 'weight' | 'price';

export interface WeightedBarcodeSettings {
  // Two-digit prefixes that mark a variable measure code; empty = feature off
  prefixes: string[];
  layout: WeightedBarcodeLayout;
  // Digits of the item code (PLU) after the prefix
  itemCodeLength: number;
  // Decimals of the embedded value (weight: 3 → grams to kg; price: 2)
  valueDecimals: number;
}

export type WeightedBarcodeScan =
  | {
      ok: true;
      prefix: string;
      // PLU as printed, and without leading zeros (as stored on variants)
      itemCode: string;
      plu: string;
      layout: WeightedBarcodeLayout;
      // Weight (in the item's unit) or price embedded in the code
      value: number;
    }
  | { ok: false; error: 'check_digit' | 'layout' };

/** GS1 mod-10 check digit of the digits before it */
export function ean13CheckDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

/** PLU as stored: digits only, no leading zeros ("01234" → "1234") */
export function normalizePlu(value: string | null | undefined): string | null {
  const digits = String(value ?? '').replace(/\s+/g, '');
  if (!/^\d{1,6}$/.test(digits)) return null;
  return digits.replace(/^0+(?=\d)/, '');
}

/**
 * Read a scanned code as a variable measure barcode. Null when it is not one
 * (feature off, not 13 digits, prefix not configured): look it up as a normal
 * barcode. An error when it looks like one but cannot be read (bad check digit).
 */
export function parseWeightedBarcode(
  code: string,
  settings: WeightedBarcodeSettings | null | undefined,
): WeightedBarcodeScan | null {
  const digits = String(code ?? '').replace(/\s+/g, '');
  if (!settings || settings.prefixes.length === 0) return null;
  if (!/^\d{13}$/.test(digits)) return null;
  const prefix = digits.slice(0, 2);
  if (!settings.prefixes.includes(prefix)) return null;

  if (ean13CheckDigit(digits.slice(0, 12)) !== Number(digits[12])) {
    return { ok: false, error: 'check_digit' };
  }
  const itemLength = Math.round(settings.itemCodeLength);
  const valueLength = 12 - 2 - itemLength;
  if (itemLength < 1 || valueLength < 1) return { ok: false, error: 'layout' };
  const itemCode = digits.slice(2, 2 + itemLength);
  const rawValue = Number(digits.slice(2 + itemLength, 12));
  const decimals = Math.min(Math.max(Math.round(settings.valueDecimals), 0), 4);
  return {
    ok: true,
    prefix,
    itemCode,
    plu: normalizePlu(itemCode) ?? itemCode,
    layout: settings.layout,
    value: rawValue / 10 ** decimals,
  };
}

// Cents of price × quantity (both up to 4 decimals), half away from zero, exact
function amountCents(price: number, quantity: number): number {
  const p = BigInt(Math.round(Number((price * 10_000).toPrecision(15))));
  const q = BigInt(Math.round(Number((quantity * 10_000).toPrecision(15))));
  const divisor = BigInt(1_000_000);
  const product = p * q;
  const quotient = product / divisor;
  const roundUp = (product % divisor) * BigInt(2) >= divisor;
  return Number(quotient) + (roundUp ? 1 : 0);
}

/**
 * Quantity of a scanned variable measure item.
 * - weight layout: the embedded weight, rounded to the unit's precision;
 * - price layout: embedded price ÷ unit price at the unit's precision, choosing the
 *   quantity whose line amount (rounded to cents) equals the label price when one
 *   exists, so the till charges exactly what the label says.
 * `amount` is the label price (price layout) or null. Null quantity when it cannot
 * be computed (no unit price, zero weight).
 */
export function scannedQuantity(
  scan: Extract<WeightedBarcodeScan, { ok: true }>,
  unitPrice: number,
  precision: number,
): { quantity: number | null; amount: number | null } {
  const places = Math.min(Math.max(Math.round(precision), 0), 4);
  const step = 10 ** places;
  const round = (v: number) =>
    Math.round(Number((v * step).toPrecision(15))) / step;
  if (scan.layout === 'weight') {
    const quantity = round(scan.value);
    return { quantity: quantity > 0 ? quantity : null, amount: null };
  }
  const amount = scan.value;
  if (!(unitPrice > 0) || !(amount > 0)) return { quantity: null, amount };
  const target = Math.round(amount * 100);
  const estimate = Math.round(
    Number(((amount / unitPrice) * step).toPrecision(15)),
  );
  // Nearest quantity (in steps) whose amount rounds to the label price
  for (let offset = 0; offset <= 3; offset++) {
    for (const candidate of offset === 0
      ? [estimate]
      : [estimate - offset, estimate + offset]) {
      if (candidate <= 0) continue;
      if (amountCents(unitPrice, candidate / step) === target) {
        return { quantity: candidate / step, amount };
      }
    }
  }
  return { quantity: estimate > 0 ? estimate / step : null, amount };
}
