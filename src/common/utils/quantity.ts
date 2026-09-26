/**
 * Stock and sale quantities (spec §5/§7): whole units for items sold by the piece,
 * exact decimals (up to 4 places, numeric(19,4)) for measured items sold by weight,
 * length or volume. Quantities are plain numbers; sums and differences go through
 * integers scaled by 10,000 so 0.1 + 0.2 stays 0.3 (no floating point drift).
 */

export const QTY_DECIMALS = 4;
const QTY_SCALE = 10_000;

/** Integer ten-thousandths of a quantity (exact for up to 4 decimals) */
export const qtyUnits = (value: number): number =>
  Math.round(Number((Number(value) * QTY_SCALE).toPrecision(15)));

const fromUnits = (units: number): number => units / QTY_SCALE || 0;

/** Round to 4 decimals (what numeric(19,4) stores), half away from zero */
export const roundQty = (value: number): number => {
  const units = Math.round(
    Number((Math.abs(Number(value)) * QTY_SCALE).toPrecision(15)),
  );
  return fromUnits(Math.sign(Number(value)) * units);
};

/** a + b + …, exactly */
export const addQty = (...values: number[]): number =>
  fromUnits(values.reduce((sum, v) => sum + qtyUnits(v ?? 0), 0));

/** a − b, exactly */
export const subQty = (a: number, b: number): number =>
  fromUnits(qtyUnits(a) - qtyUnits(b));

/** Sum of a list of quantities, exactly */
export const sumQty = (values: number[]): number => addQty(...values);

/** Round down to 4 decimals (allowances: never more than the rule gives) */
export const floorQty = (value: number): number =>
  fromUnits(Math.floor(Number((Number(value) * QTY_SCALE).toPrecision(15))));

/**
 * A usable quantity value: finite, not negative, at most 4 decimals. Whole units vs
 * decimals depend on the item's unit (see quantityError / assertUnitQuantities).
 */
export const isQuantityValue = (value: number): boolean =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  decimalPlaces(value) <= QTY_DECIMALS;

/** Number of decimals written in a quantity: 1.25 → 2, 3 → 0 */
export function decimalPlaces(value: number): number {
  if (!Number.isFinite(value)) return Infinity;
  const text = String(value);
  if (/e-/i.test(text)) {
    const [mantissa, exponent] = text.toLowerCase().split('e-');
    const fraction = mantissa.split('.')[1]?.length ?? 0;
    return fraction + Number(exponent);
  }
  return text.split('.')[1]?.length ?? 0;
}

export interface QuantityUnit {
  // Unit code printed next to quantities (kg, m, l); null = sold by the piece
  code: string | null;
  allowsDecimals: boolean;
  // Decimal places allowed when allowsDecimals (1–4)
  precision: number;
}

/** Items without a unit are sold by the piece */
export const PIECE_UNIT: QuantityUnit = {
  code: null,
  allowsDecimals: false,
  precision: 0,
};

/**
 * Why `quantity` is not a valid quantity of an item in `unit` (null = valid):
 * > 0; a whole number unless the unit allows decimals, then at most `precision`
 * decimals.
 */
export function quantityError(
  quantity: number,
  unit: QuantityUnit | null | undefined,
  options: { allowZero?: boolean } = {},
): string | null {
  const u = unit ?? PIECE_UNIT;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
    return 'Quantity must be a number';
  }
  if (options.allowZero ? quantity < 0 : quantity <= 0) {
    return options.allowZero
      ? 'Quantity cannot be negative'
      : 'Quantity must be greater than zero';
  }
  if (!u.allowsDecimals) {
    return Number.isInteger(quantity)
      ? null
      : `Quantity must be a whole number${u.code ? ` of ${u.code}` : ''}`;
  }
  const precision = Math.min(Math.max(u.precision ?? 0, 0), QTY_DECIMALS);
  return decimalPlaces(quantity) > precision
    ? `Quantity can have at most ${precision} decimal${precision === 1 ? '' : 's'}${u.code ? ` (${u.code})` : ''}`
    : null;
}

/**
 * Quantity as text with the unit's precision: 1.25 kg → "1.250 kg", 3 → "3".
 * Whole-unit items print without decimals.
 */
export function formatQuantity(
  quantity: number,
  unit?: Pick<QuantityUnit, 'code' | 'precision' | 'allowsDecimals'> | null,
): string {
  const value = roundQty(Number(quantity ?? 0));
  if (!unit?.allowsDecimals) {
    const text = String(value);
    return unit?.code ? `${text} ${unit.code}` : text;
  }
  const precision = Math.min(Math.max(unit.precision ?? 0, 0), QTY_DECIMALS);
  // Never hide decimals a stored quantity really has
  const shown = Math.max(precision, Math.min(decimalPlaces(value), 4));
  const text = value.toFixed(shown);
  return unit.code ? `${text} ${unit.code}` : text;
}
