import { calculateSale, round2, type CalcLineInput } from './sale-calculator';
import { lineRefund } from '../returns/return-math';

/**
 * Worked examples from the specification (§7 calculation contract, §12 returns)
 * and rounding boundaries where binary floating point would go wrong.
 */
const line = (overrides: Partial<CalcLineInput> = {}): CalcLineInput => ({
  key: 'l1',
  productId: 'p1',
  categoryId: null,
  quantity: 1,
  unitPrice: 10,
  ...overrides,
});

describe('specification fixtures', () => {
  it('§7: two items at 10.00, 10% line discount, 10% exclusive tax → 19.80', () => {
    const result = calculateSale([line({ quantity: 2, discountPercent: 10 })], {
      taxRate: 10,
      pricesIncludeTax: false,
    });
    expect(result).toMatchObject({
      subtotal: 20,
      discountAmount: 2,
      taxAmount: 1.8,
      total: 19.8,
    });
  });

  it('§12: returning one of the two units refunds 9.90', () => {
    const [sold] = calculateSale([line({ quantity: 2, discountPercent: 10 })], {
      taxRate: 10,
      pricesIncludeTax: false,
    }).lines;
    const first = lineRefund(sold, 0, 1);
    const second = lineRefund(sold, 1, 1);
    expect(first.total).toBe(9.9);
    // Both halves add up to the original line exactly
    expect(round2(first.total + second.total)).toBe(19.8);
  });

  it('inclusive tax: 11.00 at 10% included contains 1.00 of tax', () => {
    const result = calculateSale([line({ unitPrice: 11 })], {
      taxRate: 10,
      pricesIncludeTax: true,
    });
    expect(result).toMatchObject({ total: 11, taxAmount: 1 });
  });

  it('allocates an order discount with its remainder so lines add up', () => {
    const result = calculateSale(
      [
        line({ key: 'a', unitPrice: 1 }),
        line({ key: 'b', unitPrice: 1 }),
        line({ key: 'c', unitPrice: 1 }),
      ],
      {
        taxRate: 0,
        pricesIncludeTax: false,
        cartDiscount: { type: 'fixed', value: 1 },
      },
    );
    const parts = result.lines.map((l) => l.discountAmount);
    expect(round2(parts.reduce((a, b) => a + b, 0))).toBe(1);
    expect([...parts].sort()).toEqual([0.33, 0.33, 0.34]);
    expect(result.total).toBe(2);
  });
});

describe('exact decimal rounding', () => {
  it('rounds half-cents away from zero (1.005 → 1.01, not 1.00)', () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.675)).toBe(2.68);
    expect(round2(-1.005)).toBe(-1.01);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });

  it('computes 1.005 × 1 and 0.1 × 3 exactly', () => {
    expect(
      calculateSale([line({ unitPrice: 1.005 })], {
        taxRate: 0,
        pricesIncludeTax: false,
      }).total,
    ).toBe(1.01);
    expect(
      calculateSale([line({ unitPrice: 0.1, quantity: 3 })], {
        taxRate: 0,
        pricesIncludeTax: false,
      }).total,
    ).toBe(0.3);
  });

  it('keeps 4-decimal unit prices and rates exact', () => {
    // 3 × 3.3333 = 9.9999 → 10.00; 8.25% of 10.00 = 0.825 → 0.83
    const result = calculateSale([line({ unitPrice: 3.3333, quantity: 3 })], {
      taxRate: 8.25,
      pricesIncludeTax: false,
    });
    expect(result).toMatchObject({
      subtotal: 10,
      taxAmount: 0.83,
      total: 10.83,
    });
  });

  it('adds many small amounts without drifting', () => {
    const lines = Array.from({ length: 1000 }, (_, i) =>
      line({ key: String(i), unitPrice: 0.1 }),
    );
    expect(
      calculateSale(lines, { taxRate: 0, pricesIncludeTax: false }).total,
    ).toBe(100);
  });
});
