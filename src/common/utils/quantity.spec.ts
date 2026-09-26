import {
  addQty,
  decimalPlaces,
  floorQty,
  formatQuantity,
  isQuantityValue,
  quantityError,
  roundQty,
  subQty,
  sumQty,
} from './quantity';

const KG = { code: 'kg', allowsDecimals: true, precision: 3 };
const PIECE = { code: 'pc', allowsDecimals: false, precision: 0 };

describe('quantity arithmetic', () => {
  it('adds and subtracts decimals exactly', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(addQty(0.1, 0.2)).toBe(0.3);
    expect(subQty(0.3, 0.1)).toBe(0.2);
    expect(subQty(0.3, 0.3)).toBe(0);
    expect(sumQty([1.25, 0.005, 2.745])).toBe(4);
    expect(sumQty(Array.from({ length: 10 }, () => 0.1))).toBe(1);
  });

  it('rounds to the 4 decimals numeric(19,4) stores, half away from zero', () => {
    expect(roundQty(1.00005)).toBe(1.0001);
    expect(roundQty(-1.00005)).toBe(-1.0001);
    expect(roundQty(0.1 + 0.2)).toBe(0.3);
    expect(floorQty(0.07999)).toBe(0.0799);
  });

  it('counts decimal places, including exponent notation', () => {
    expect(decimalPlaces(3)).toBe(0);
    expect(decimalPlaces(1.25)).toBe(2);
    expect(decimalPlaces(1e-7)).toBe(7);
    expect(isQuantityValue(1.2345)).toBe(true);
    expect(isQuantityValue(1.23456)).toBe(false);
    expect(isQuantityValue(-1)).toBe(false);
  });
});

describe('quantityError (spec §5: unit-based vs measured quantities)', () => {
  it('only accepts decimals for units that allow them', () => {
    expect(quantityError(1.5, PIECE)).toBe(
      'Quantity must be a whole number of pc',
    );
    expect(quantityError(1.5, null)).toBe('Quantity must be a whole number');
    expect(quantityError(2, PIECE)).toBeNull();
    expect(quantityError(1.25, KG)).toBeNull();
  });

  it('enforces the unit precision', () => {
    expect(quantityError(1.25, KG)).toBeNull();
    expect(quantityError(1.2505, KG)).toBe(
      'Quantity can have at most 3 decimals (kg)',
    );
    expect(
      quantityError(0.55, { code: 'm', allowsDecimals: true, precision: 1 }),
    ).toBe('Quantity can have at most 1 decimal (m)');
  });

  it('requires more than zero (zero only where allowed)', () => {
    expect(quantityError(0, KG)).toBe('Quantity must be greater than zero');
    expect(quantityError(-1, PIECE)).toBe('Quantity must be greater than zero');
    expect(quantityError(0, PIECE, { allowZero: true })).toBeNull();
    expect(quantityError(Number.NaN, KG)).toBe('Quantity must be a number');
  });
});

describe('formatQuantity', () => {
  it('shows measured quantities with the unit precision and symbol', () => {
    expect(formatQuantity(1.25, KG)).toBe('1.250 kg');
    expect(formatQuantity(2, KG)).toBe('2.000 kg');
    // Never hides decimals a quantity really has
    expect(formatQuantity(1.2345, KG)).toBe('1.2345 kg');
  });

  it('shows pieces as whole numbers', () => {
    expect(formatQuantity(3, null)).toBe('3');
    expect(formatQuantity(3, PIECE)).toBe('3 pc');
  });
});
