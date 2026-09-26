import {
  CalcDiscount,
  CalcLineInput,
  CalcOptions,
  calculateSale,
  round2,
} from './sale-calculator';

const NO_TAX: CalcOptions = { taxRate: 0, pricesIncludeTax: false };

let seq = 0;
function line(
  unitPrice: number,
  quantity = 1,
  extra: Partial<CalcLineInput> = {},
): CalcLineInput {
  seq += 1;
  return {
    key: `l${seq}`,
    productId: `p${seq}`,
    categoryId: null,
    quantity,
    unitPrice,
    ...extra,
  };
}

function code(extra: Partial<CalcDiscount>): CalcDiscount {
  return {
    code: 'SAVE',
    discountType: 'percentage',
    scope: 'cart',
    ...extra,
  };
}

const lineDiscounts = (result: ReturnType<typeof calculateSale>) =>
  result.lines.map((l) => l.discountAmount);

describe('round2', () => {
  it('rounds to cents, half away from zero', () => {
    expect(round2(1.234)).toBe(1.23);
    expect(round2(0.125)).toBe(0.13);
    expect(round2(-0.125)).toBe(-0.13);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});

describe('calculateSale', () => {
  it('returns zeros for an empty cart', () => {
    expect(calculateSale([], NO_TAX)).toEqual({
      lines: [],
      subtotal: 0,
      discountAmount: 0,
      taxAmount: 0,
      total: 0,
      discountMessage: undefined,
    });
  });

  describe('line subtotal', () => {
    it('is unit price × quantity, rounded to cents', () => {
      const result = calculateSale([line(2.99, 3), line(0.1, 3)], NO_TAX);
      expect(result.lines.map((l) => l.subtotal)).toEqual([8.97, 0.3]);
      expect(result.subtotal).toBe(9.27);
      expect(result.total).toBe(9.27);
    });

    it('keeps the input fields on each line', () => {
      const input = line(5, 2, { categoryId: 'c1' });
      const [result] = calculateSale([input], NO_TAX).lines;
      expect(result).toMatchObject(input);
    });
  });

  describe('manual line discount', () => {
    it('takes a percentage off the line', () => {
      const result = calculateSale(
        [line(10, 2, { discountPercent: 15 })],
        NO_TAX,
      );
      expect(result.lines[0].discountAmount).toBe(3);
      expect(result.discountAmount).toBe(3);
      expect(result.total).toBe(17);
    });

    it('clamps the percentage to 0–100', () => {
      const result = calculateSale(
        [
          line(20, 1, { discountPercent: 150 }),
          line(20, 1, { discountPercent: -5 }),
        ],
        NO_TAX,
      );
      expect(lineDiscounts(result)).toEqual([20, 0]);
      expect(result.total).toBe(20);
    });
  });

  describe('manual cart discount', () => {
    it('applies a percentage after line discounts', () => {
      const result = calculateSale([line(100, 1, { discountPercent: 10 })], {
        ...NO_TAX,
        cartDiscount: { type: 'percentage', value: 10 },
      });
      // 10 off the line, then 10% of the remaining 90
      expect(result.discountAmount).toBe(19);
      expect(result.total).toBe(81);
    });

    it('caps a percentage at 100%', () => {
      const result = calculateSale([line(40)], {
        ...NO_TAX,
        cartDiscount: { type: 'percentage', value: 250 },
      });
      expect(result.discountAmount).toBe(40);
      expect(result.total).toBe(0);
    });

    it('never discounts more than the cart is worth', () => {
      const result = calculateSale([line(5), line(3)], {
        ...NO_TAX,
        cartDiscount: { type: 'fixed', value: 50 },
      });
      expect(result.discountAmount).toBe(8);
      expect(result.total).toBe(0);
    });

    it('ignores a zero discount', () => {
      const result = calculateSale([line(5)], {
        ...NO_TAX,
        cartDiscount: { type: 'fixed', value: 0 },
      });
      expect(result.discountAmount).toBe(0);
    });

    it('allocates a fixed amount so the parts add up exactly', () => {
      const result = calculateSale([line(10), line(10), line(10)], {
        ...NO_TAX,
        cartDiscount: { type: 'fixed', value: 10 },
      });
      expect(lineDiscounts(result)).toEqual([3.34, 3.33, 3.33]);
      expect(result.discountAmount).toBe(10);
      expect(result.total).toBe(20);
    });

    it('gives the rounding remainder to the largest line', () => {
      const result = calculateSale([line(5), line(20), line(10)], {
        ...NO_TAX,
        cartDiscount: { type: 'fixed', value: 1 },
      });
      // 100 cents split 5:20:10 → 14 / 57 / 28 (= 99), +1 to the 20.00 line
      expect(lineDiscounts(result)).toEqual([0.14, 0.58, 0.28]);
      expect(result.discountAmount).toBe(1);
    });
  });

  describe('discount code — cart scope', () => {
    it('takes a percentage off the whole cart, split by line value', () => {
      const result = calculateSale([line(10), line(30)], {
        ...NO_TAX,
        discount: code({ percentage: 10 }),
      });
      expect(lineDiscounts(result)).toEqual([1, 3]);
      expect(result.total).toBe(36);
      expect(result.discountMessage).toBeUndefined();
    });

    it('takes a fixed amount off the cart, allocated exactly', () => {
      const result = calculateSale([line(7), line(7), line(7)], {
        ...NO_TAX,
        discount: code({ discountType: 'fixed_amount', value: 5 }),
      });
      expect(lineDiscounts(result)).toEqual([1.68, 1.66, 1.66]);
      expect(result.discountAmount).toBe(5);
      expect(result.total).toBe(16);
    });

    it('is applied on top of manual line discounts', () => {
      const result = calculateSale(
        [line(50, 1, { discountPercent: 20 }), line(60)],
        { ...NO_TAX, discount: code({ percentage: 10 }) },
      );
      // net 40 + 60 → 10% = 4 + 6
      expect(lineDiscounts(result)).toEqual([14, 6]);
      expect(result.total).toBe(90);
    });

    it('respects maxDiscountAmount', () => {
      const result = calculateSale([line(100), line(100)], {
        ...NO_TAX,
        discount: code({ percentage: 50, maxDiscountAmount: 30 }),
      });
      expect(result.discountAmount).toBe(30);
      expect(lineDiscounts(result)).toEqual([15, 15]);
    });

    it('cannot exceed the cart value', () => {
      const result = calculateSale([line(4)], {
        ...NO_TAX,
        discount: code({ discountType: 'fixed_amount', value: 10 }),
      });
      expect(result.discountAmount).toBe(4);
      expect(result.total).toBe(0);
    });

    it('leaves excluded products out of the discount', () => {
      const excluded = line(100);
      const result = calculateSale([excluded, line(50)], {
        ...NO_TAX,
        discount: code({
          percentage: 10,
          excludedProductIds: [excluded.productId],
        }),
      });
      expect(lineDiscounts(result)).toEqual([0, 5]);
      expect(result.total).toBe(145);
    });

    it('is combined with a manual cart discount (code first)', () => {
      const result = calculateSale([line(100)], {
        ...NO_TAX,
        discount: code({ percentage: 10 }),
        cartDiscount: { type: 'fixed', value: 5 },
      });
      expect(result.discountAmount).toBe(15);
      expect(result.total).toBe(85);
    });
  });

  describe('discount code — minimum purchase', () => {
    it('gives nothing and explains why when the minimum is not met', () => {
      const result = calculateSale([line(40)], {
        ...NO_TAX,
        discount: code({ percentage: 10, minPurchaseAmount: 50 }),
      });
      expect(result.discountAmount).toBe(0);
      expect(result.discountMessage).toBe(
        'Minimum purchase of 50.00 required for SAVE',
      );
    });

    it('applies once the gross subtotal reaches the minimum', () => {
      const result = calculateSale([line(25, 2)], {
        ...NO_TAX,
        discount: code({ percentage: 10, minPurchaseAmount: 50 }),
      });
      expect(result.discountAmount).toBe(5);
      expect(result.discountMessage).toBeUndefined();
    });
  });

  describe('discount code — product and category scope', () => {
    it('only discounts the listed products', () => {
      const target = line(10);
      const result = calculateSale([target, line(10)], {
        ...NO_TAX,
        discount: code({
          scope: 'product',
          percentage: 20,
          applicableProductIds: [target.productId],
        }),
      });
      expect(lineDiscounts(result)).toEqual([2, 0]);
    });

    it('only discounts lines in the listed categories', () => {
      const result = calculateSale(
        [
          line(10, 1, { categoryId: 'drinks' }),
          line(10, 1, { categoryId: 'food' }),
          line(10, 1, { categoryId: null }),
        ],
        {
          ...NO_TAX,
          discount: code({
            scope: 'category',
            percentage: 50,
            applicableCategoryIds: ['drinks'],
          }),
        },
      );
      expect(lineDiscounts(result)).toEqual([5, 0, 0]);
    });

    it('skips excluded products even inside a discounted category', () => {
      const excluded = line(10, 1, { categoryId: 'drinks' });
      const result = calculateSale(
        [excluded, line(10, 1, { categoryId: 'drinks' })],
        {
          ...NO_TAX,
          discount: code({
            scope: 'category',
            percentage: 50,
            applicableCategoryIds: ['drinks'],
            excludedProductIds: [excluded.productId],
          }),
        },
      );
      expect(lineDiscounts(result)).toEqual([0, 5]);
    });

    it('takes a fixed amount off each unit, capped at the line value', () => {
      const a = line(10, 3);
      const b = line(1, 2);
      const result = calculateSale([a, b], {
        ...NO_TAX,
        discount: code({
          scope: 'product',
          discountType: 'fixed_amount',
          value: 2,
          applicableProductIds: [a.productId, b.productId],
        }),
      });
      expect(lineDiscounts(result)).toEqual([6, 2]);
    });

    it('works on the price left after the manual line discount', () => {
      const a = line(10, 1, { discountPercent: 50 });
      const result = calculateSale([a], {
        ...NO_TAX,
        discount: code({
          scope: 'product',
          percentage: 10,
          applicableProductIds: [a.productId],
        }),
      });
      expect(result.discountAmount).toBe(5.5);
    });

    it('caps the total with maxDiscountAmount', () => {
      const a = line(100);
      const b = line(100);
      const result = calculateSale([a, b], {
        ...NO_TAX,
        discount: code({
          scope: 'product',
          percentage: 50,
          maxDiscountAmount: 20,
          applicableProductIds: [a.productId, b.productId],
        }),
      });
      expect(result.discountAmount).toBe(20);
      expect(lineDiscounts(result)).toEqual([10, 10]);
    });

    it('explains when no items qualify', () => {
      const result = calculateSale([line(10)], {
        ...NO_TAX,
        discount: code({
          scope: 'product',
          percentage: 10,
          applicableProductIds: ['something-else'],
        }),
      });
      expect(result.discountAmount).toBe(0);
      expect(result.discountMessage).toBe(
        'No items in the cart qualify for SAVE',
      );
    });
  });

  describe('discount code — buy X get Y', () => {
    const bxgy = (productId: string, buy = 2, get = 1) =>
      code({
        scope: 'product',
        discountType: 'buy_x_get_y',
        buyQuantity: buy,
        getQuantity: get,
        applicableProductIds: [productId],
      });

    it('makes every (X+1)th unit free', () => {
      const a = line(3, 7);
      const result = calculateSale([a], {
        ...NO_TAX,
        discount: bxgy(a.productId),
      });
      // 7 units, buy 2 get 1 → 2 free
      expect(result.discountAmount).toBe(6);
      expect(result.total).toBe(15);
    });

    it('gives nothing below the threshold', () => {
      const a = line(3, 2);
      const result = calculateSale([a], {
        ...NO_TAX,
        discount: bxgy(a.productId),
      });
      expect(result.discountAmount).toBe(0);
      expect(result.discountMessage).toBe(
        'No items in the cart qualify for SAVE',
      );
    });

    it('ignores a misconfigured discount', () => {
      const a = line(3, 10);
      const result = calculateSale([a], {
        ...NO_TAX,
        discount: bxgy(a.productId, 0, 1),
      });
      expect(result.discountAmount).toBe(0);
    });

    it('never exceeds what is left of the line', () => {
      const a = line(10, 2, { discountPercent: 90 });
      const result = calculateSale([a], {
        ...NO_TAX,
        discount: bxgy(a.productId, 1, 1),
      });
      // 20 − 18 manual leaves 2; one free unit (10) is capped at 2
      expect(result.discountAmount).toBe(20);
      expect(result.total).toBe(0);
    });
  });

  describe('tax', () => {
    it('adds tax on top when prices exclude tax', () => {
      const result = calculateSale([line(10)], {
        taxRate: 8.25,
        pricesIncludeTax: false,
      });
      expect(result.taxAmount).toBe(0.83);
      expect(result.total).toBe(10.83);
    });

    it('extracts tax when prices include it', () => {
      const result = calculateSale([line(11)], {
        taxRate: 10,
        pricesIncludeTax: true,
      });
      expect(result.taxAmount).toBe(1);
      expect(result.total).toBe(11);
      expect(result.subtotal).toBe(11);
    });

    it('is computed on the discounted amount', () => {
      const result = calculateSale([line(100)], {
        taxRate: 10,
        pricesIncludeTax: false,
        cartDiscount: { type: 'percentage', value: 20 },
      });
      expect(result.taxAmount).toBe(8);
      expect(result.total).toBe(88);
    });

    it('is rounded per line, then summed', () => {
      const result = calculateSale([line(1), line(1)], {
        taxRate: 8.25,
        pricesIncludeTax: false,
      });
      // 0.0825 → 0.08 on each line (not 0.165 → 0.17 on the cart)
      expect(result.lines.map((l) => l.taxAmount)).toEqual([0.08, 0.08]);
      expect(result.taxAmount).toBe(0.16);
      expect(result.total).toBe(2.16);
    });

    it('treats a negative rate as zero', () => {
      const result = calculateSale([line(10)], {
        taxRate: -5,
        pricesIncludeTax: false,
      });
      expect(result.taxAmount).toBe(0);
      expect(result.total).toBe(10);
    });
  });

  it('keeps totals consistent: total = subtotal − discount + tax', () => {
    const a = line(19.99, 3, { discountPercent: 7 });
    const b = line(4.35, 11, { categoryId: 'c' });
    const c = line(0.99, 1);
    const result = calculateSale([a, b, c], {
      taxRate: 7.5,
      pricesIncludeTax: false,
      discount: code({ percentage: 12.5 }),
      cartDiscount: { type: 'fixed', value: 3.33 },
    });
    expect(result.total).toBe(
      round2(result.subtotal - result.discountAmount + result.taxAmount),
    );
    for (const l of result.lines) {
      expect(l.total).toBe(round2(l.subtotal - l.discountAmount + l.taxAmount));
      // Everything is in whole cents
      for (const value of [l.discountAmount, l.taxAmount, l.total]) {
        expect(Math.round(value * 100)).toBeCloseTo(value * 100, 6);
      }
    }
  });
});

describe('per-line tax rates', () => {
  const base = {
    key: 'x',
    productId: 'p',
    categoryId: null,
    quantity: 1,
    unitPrice: 100,
  };

  it('uses each line’s own rate and the cart rate for the rest', () => {
    const result = calculateSale(
      [
        { ...base, key: 'food', taxRate: 5 },
        { ...base, key: 'exempt', taxRate: 0 },
        { ...base, key: 'default' },
      ],
      { taxRate: 10, pricesIncludeTax: false },
    );
    expect(result.lines.map((l) => l.taxAmount)).toEqual([5, 0, 10]);
    expect(result.taxAmount).toBe(15);
    expect(result.total).toBe(315);
  });

  it('extracts each line’s own rate when prices include tax', () => {
    const result = calculateSale(
      [
        { ...base, key: 'a', unitPrice: 105, taxRate: 5 },
        { ...base, key: 'b', unitPrice: 110, taxRate: null },
      ],
      { taxRate: 10, pricesIncludeTax: true },
    );
    expect(result.lines.map((l) => l.taxAmount)).toEqual([5, 10]);
    expect(result.total).toBe(215);
  });

  it('applies the line rate after cart discounts', () => {
    const result = calculateSale(
      [
        { ...base, key: 'a', taxRate: 0 },
        { ...base, key: 'b', taxRate: 20 },
      ],
      {
        taxRate: 10,
        pricesIncludeTax: false,
        cartDiscount: { type: 'percentage', value: 10 },
      },
    );
    // Each line nets 90: 0% and 20% → 18 tax
    expect(result.taxAmount).toBe(18);
    expect(result.total).toBe(198);
  });
});

describe('measured quantities (sold by weight / length / volume)', () => {
  it('rounds unit price × weight half away from zero: 1.250 kg at 3.99 = 4.99', () => {
    const result = calculateSale([line(3.99, 1.25)], NO_TAX);
    // 4.9875 → 4.99
    expect(result.lines[0].subtotal).toBe(4.99);
    expect(result.total).toBe(4.99);
  });

  it('0.333 m at 12.00 = 4.00', () => {
    const result = calculateSale([line(12, 0.333)], NO_TAX);
    // 3.996 → 4.00
    expect(result.subtotal).toBe(4);
  });

  it('computes exactly where floating point would drift', () => {
    // 0.1 × 3 in binary is 0.30000000000000004; 2.675 kg at 1.00 = 2.675 → 2.68
    expect(calculateSale([line(3, 0.1)], NO_TAX).subtotal).toBe(0.3);
    expect(calculateSale([line(1, 2.675)], NO_TAX).subtotal).toBe(2.68);
    expect(calculateSale([line(0.0001, 0.0001)], NO_TAX).subtotal).toBe(0);
  });

  it('taxes a measured line on its rounded amount', () => {
    // 1.250 kg × 3.99 = 4.99; 8.25% → 0.411675 → 0.41
    const excl = calculateSale([line(3.99, 1.25)], {
      taxRate: 8.25,
      pricesIncludeTax: false,
    });
    expect(excl).toMatchObject({ subtotal: 4.99, taxAmount: 0.41, total: 5.4 });
    // Included: 4.99 − 4.99 / 1.1 = 0.4536… → 0.45
    const incl = calculateSale([line(3.99, 1.25)], {
      taxRate: 10,
      pricesIncludeTax: true,
    });
    expect(incl).toMatchObject({
      subtotal: 4.99,
      taxAmount: 0.45,
      total: 4.99,
    });
  });

  it('applies line and cart percentage discounts to measured lines', () => {
    const result = calculateSale(
      [line(10, 0.75, { discountPercent: 10 }), line(2, 3)],
      { ...NO_TAX, cartDiscount: { type: 'percentage', value: 50 } },
    );
    // 7.50 − 0.75 = 6.75; + 6.00 = 12.75; half off = 6.375 → 6.38
    expect(result.subtotal).toBe(13.5);
    expect(result.discountAmount).toBe(0.75 + 6.38);
    expect(result.total).toBe(6.37);
  });

  it('gives per-unit fixed discounts on whole units only', () => {
    const result = calculateSale([line(4, 2.75, { productId: 'kg' })], {
      ...NO_TAX,
      discount: code({
        scope: 'product',
        discountType: 'fixed_amount',
        value: 1,
        applicableProductIds: ['kg'],
      }),
    });
    // 2.75 kg × 4 = 11.00; 1.00 off each of the 2 whole kg
    expect(result.subtotal).toBe(11);
    expect(result.discountAmount).toBe(2);
  });

  it('counts whole units only for buy X get Y', () => {
    const bxgy = code({
      scope: 'product',
      discountType: 'buy_x_get_y',
      buyQuantity: 1,
      getQuantity: 1,
      applicableProductIds: ['kg'],
    });
    const under = calculateSale([line(5, 1.99, { productId: 'kg' })], {
      ...NO_TAX,
      discount: bxgy,
    });
    expect(under.discountAmount).toBe(0);
    const over = calculateSale([line(5, 2.5, { productId: 'kg' })], {
      ...NO_TAX,
      discount: bxgy,
    });
    // 2 whole kg → 1 free
    expect(over.discountAmount).toBe(5);
  });

  it('leaves whole-unit results unchanged', () => {
    const result = calculateSale([line(19.99, 3)], {
      taxRate: 8.25,
      pricesIncludeTax: false,
    });
    expect(result).toMatchObject({ subtotal: 59.97, taxAmount: 4.95 });
  });
});
