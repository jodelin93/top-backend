/**
 * Pure sale math: prices, discounts and tax for a cart.
 * No framework or database dependencies, so it is shared by the API and unit tests
 * (and mirrored in the POS frontend for offline totals).
 *
 * Order of operations per line:
 *   subtotal = unitPrice × quantity
 *   − manual line discount (%)
 *   − product/category discount code
 *   − share of cart-level discounts (allocated in proportion to line value)
 *   = net; tax is computed on net (extracted from it when prices include tax)
 *
 * Each line may carry its own tax rate (per-product tax categories); lines without
 * one use the cart-wide `taxRate` option.
 *
 * Money is computed exactly: amounts as integer cents, unit prices, quantities and
 * rates as integers scaled by 10,000, products through BigInt. Inputs and results are
 * plain numbers with at most 4 (inputs) or 2 (results) decimals, which JSON and the
 * database (numeric(19,4)) carry exactly. See DECISION_REGISTER.md (money representation).
 *
 * Quantities may be fractional for measured items (sold by weight, length or volume,
 * e.g. 1.250 kg): the line subtotal is unitPrice × quantity rounded half away from
 * zero to cents (1.250 kg × 3.99 = 4.9875 → 4.99). Per-unit fixed discounts and
 * buy X get Y only count whole units (floor of the quantity).
 */

export type CalcDiscountType = 'percentage' | 'fixed_amount' | 'buy_x_get_y';
export type CalcDiscountScope = 'product' | 'category' | 'cart';

export interface CalcLineInput {
  key: string;
  productId: string;
  categoryId: string | null;
  // Units sold; up to 4 decimals for measured items (e.g. 1.25 kg)
  quantity: number;
  unitPrice: number;
  // Manual discount entered by the cashier, 0–100
  discountPercent?: number;
  // Tax rate for this line in percent (e.g. 0 for exempt); overrides options.taxRate
  taxRate?: number | null;
}

export interface CalcDiscount {
  code: string;
  discountType: CalcDiscountType;
  scope: CalcDiscountScope;
  value?: number | null;
  percentage?: number | null;
  buyQuantity?: number | null;
  getQuantity?: number | null;
  minPurchaseAmount?: number | null;
  maxDiscountAmount?: number | null;
  applicableProductIds?: string[];
  applicableCategoryIds?: string[];
  excludedProductIds?: string[];
}

export interface CalcManualCartDiscount {
  type: 'percentage' | 'fixed';
  value: number;
}

export interface CalcOptions {
  taxRate: number; // percent, e.g. 8.25
  pricesIncludeTax: boolean;
  discount?: CalcDiscount | null;
  cartDiscount?: CalcManualCartDiscount | null;
}

export interface CalcLineResult extends CalcLineInput {
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
}

export interface CalcResult {
  lines: CalcLineResult[];
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  total: number;
  // Why a discount code gave nothing (e.g. minimum not met), if applicable
  discountMessage?: string;
}

/**
 * Round to cents, half away from zero, exactly for decimal inputs: 1.005 → 1.01.
 * (Plain Math.round(x * 100) gives 1.00, because 1.005 × 100 is 100.49999… in binary.)
 */
export const round2 = (value: number): number => {
  const scaled = Number((Math.abs(value) * 100).toPrecision(15));
  return (Math.sign(value) * Math.round(scaled)) / 100;
};

// ---- Exact integer arithmetic ----
// Amounts are handled as integer cents; unit prices, quantities, rates and percentages
// as integers scaled by 10,000 (4 decimals, as stored in the database). Products go
// through BigInt so nothing is lost to binary floating point.

const RATE_SCALE = 10_000;
const QTY_SCALE = 10_000;

/** Integer value of a decimal with at most 4 fraction digits, scaled by `scale` */
const scaled = (value: number, scale: number): number =>
  Math.round(Number((value * scale).toPrecision(15)));

const toCents = (value: number): number => scaled(value, 100);
const fromCents = (cents: number): number => cents / 100;

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

/** Cents of a percentage of an amount in cents: pct may have 4 decimals */
const percentOf = (cents: number, pct: number): number =>
  mulDiv(cents, scaled(pct, RATE_SCALE), 100 * RATE_SCALE);

/** Cents of `price` (4 decimals) × `quantity` (4 decimals), rounded half away from zero */
const priceTimes = (price: number, quantity: number): number =>
  mulDiv(
    scaled(price, RATE_SCALE),
    scaled(quantity, QTY_SCALE),
    (RATE_SCALE * QTY_SCALE) / 100,
  );

/** Whole units in a quantity: 2.75 kg → 2 (per-unit discounts count whole units only) */
const wholeUnits = (quantity: number): number =>
  Math.floor(scaled(quantity, QTY_SCALE) / QTY_SCALE);

function appliesToLine(discount: CalcDiscount, line: CalcLineInput): boolean {
  if (discount.excludedProductIds?.includes(line.productId)) {
    return false;
  }
  if (discount.scope === 'product') {
    return !!discount.applicableProductIds?.includes(line.productId);
  }
  if (discount.scope === 'category') {
    return (
      !!line.categoryId &&
      !!discount.applicableCategoryIds?.includes(line.categoryId)
    );
  }
  return true;
}

/**
 * Split `cents` across lines in proportion to `weights` (integer cents),
 * giving any rounding remainder to the largest line so the parts add up exactly.
 */
function allocate(cents: number, weights: number[]): number[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (cents <= 0 || totalWeight <= 0) {
    return weights.map(() => 0);
  }
  const parts = weights.map((w) =>
    Number((BigInt(cents) * BigInt(w)) / BigInt(totalWeight)),
  );
  const remainder = cents - parts.reduce((a, b) => a + b, 0);
  const largest = weights.indexOf(Math.max(...weights));
  parts[largest] += remainder;
  return parts;
}

export function calculateSale(
  inputs: CalcLineInput[],
  options: CalcOptions,
): CalcResult {
  // Working values are integer cents
  const lines = inputs.map((input) => {
    const subtotal = priceTimes(input.unitPrice, input.quantity);
    const pct = Math.min(Math.max(input.discountPercent ?? 0, 0), 100);
    return { input, subtotal, discount: percentOf(subtotal, pct) };
  });

  const grossSubtotal = lines.reduce((sum, l) => sum + l.subtotal, 0);
  let discountMessage: string | undefined;

  // ---- Discount code ----
  const discount = options.discount;
  if (discount) {
    if (
      discount.minPurchaseAmount &&
      grossSubtotal < toCents(discount.minPurchaseAmount)
    ) {
      discountMessage = `Minimum purchase of ${discount.minPurchaseAmount.toFixed(2)} required for ${discount.code}`;
    } else if (discount.scope === 'cart') {
      // Excluded products neither receive the discount nor count towards it
      const net = lines.map((l) =>
        appliesToLine(discount, l.input) ? l.subtotal - l.discount : 0,
      );
      const base = net.reduce((a, b) => a + b, 0);
      let amount =
        discount.discountType === 'percentage'
          ? percentOf(base, discount.percentage ?? 0)
          : toCents(discount.value ?? 0);
      if (discount.maxDiscountAmount != null) {
        amount = Math.min(amount, toCents(discount.maxDiscountAmount));
      }
      allocate(Math.min(amount, base), net).forEach((part, i) => {
        lines[i].discount += part;
      });
    } else {
      // Product / category scope: compute per eligible line, then cap in total
      const perLine = lines.map((line) => {
        if (!appliesToLine(discount, line.input)) {
          return 0;
        }
        const net = line.subtotal - line.discount;
        switch (discount.discountType) {
          case 'percentage':
            return percentOf(net, discount.percentage ?? 0);
          case 'fixed_amount':
            // Amount off each (whole) unit
            return Math.min(
              priceTimes(discount.value ?? 0, wholeUnits(line.input.quantity)),
              net,
            );
          case 'buy_x_get_y': {
            const buy = discount.buyQuantity ?? 0;
            const get = discount.getQuantity ?? 0;
            if (buy <= 0 || get <= 0) {
              return 0;
            }
            const freeUnits =
              Math.floor(wholeUnits(line.input.quantity) / (buy + get)) * get;
            return Math.min(priceTimes(line.input.unitPrice, freeUnits), net);
          }
        }
      });
      let totalAmount = perLine.reduce((a, b) => a + b, 0);
      if (
        discount.maxDiscountAmount != null &&
        totalAmount > toCents(discount.maxDiscountAmount)
      ) {
        totalAmount = toCents(discount.maxDiscountAmount);
      }
      allocate(totalAmount, perLine).forEach((part, i) => {
        lines[i].discount += part;
      });
      if (totalAmount === 0) {
        discountMessage = `No items in the cart qualify for ${discount.code}`;
      }
    }
  }

  // ---- Manual cart discount ----
  const cartDiscount = options.cartDiscount;
  if (cartDiscount && cartDiscount.value > 0) {
    const net = lines.map((l) => l.subtotal - l.discount);
    const base = net.reduce((a, b) => a + b, 0);
    const amount =
      cartDiscount.type === 'percentage'
        ? percentOf(base, Math.min(cartDiscount.value, 100))
        : toCents(cartDiscount.value);
    allocate(Math.min(amount, base), net).forEach((part, i) => {
      lines[i].discount += part;
    });
  }

  // ---- Tax ----
  const results: CalcLineResult[] = lines.map((line) => {
    const rate = scaled(
      Math.max(line.input.taxRate ?? options.taxRate, 0),
      RATE_SCALE,
    );
    const net = line.subtotal - line.discount;
    const taxAmount = options.pricesIncludeTax
      ? net - mulDiv(net, 100 * RATE_SCALE, 100 * RATE_SCALE + rate)
      : mulDiv(net, rate, 100 * RATE_SCALE);
    const total = options.pricesIncludeTax ? net : net + taxAmount;
    return {
      ...line.input,
      subtotal: fromCents(line.subtotal),
      discountAmount: fromCents(line.discount),
      taxAmount: fromCents(taxAmount),
      total: fromCents(total),
    };
  });

  const sum = (key: 'subtotal' | 'discountAmount' | 'taxAmount' | 'total') =>
    fromCents(results.reduce((acc, l) => acc + toCents(l[key]), 0));

  return {
    lines: results,
    subtotal: sum('subtotal'),
    discountAmount: sum('discountAmount'),
    taxAmount: sum('taxAmount'),
    total: sum('total'),
    discountMessage,
  };
}
