import { ForbiddenException } from '@nestjs/common';
import {
  approvalRequired,
  cartDiscountPercent,
  requiredOverrides,
} from './sale-authorization';
import { CalcLineInput } from './sale-calculator';

const line = (
  unitPrice: number,
  catalogPrice = unitPrice,
  discountPercent?: number,
) => ({
  unitPrice,
  catalogPrice,
  discountPercent,
});

describe('requiredOverrides', () => {
  it('needs nothing for a plain cart', () => {
    expect(requiredOverrides([line(10)], 0, 20).permissions).toEqual([]);
  });

  it('needs pos.discount for a line discount within the limit', () => {
    const check = requiredOverrides([line(10, 10, 20)], 0, 20);
    expect(check.permissions).toEqual(['pos.discount']);
    expect(check.maxPercent).toBe(20);
  });

  it('needs pos.discount.override above the limit (and not pos.discount as well)', () => {
    const check = requiredOverrides([line(10, 10, 25)], 0, 20);
    expect(check.permissions).toEqual(['pos.discount.override']);
    expect(check.reasons[0]).toContain('25% discount (limit 20%)');
  });

  it('checks the cart discount percentage against the limit', () => {
    expect(requiredOverrides([line(10)], 15, 20).permissions).toEqual([
      'pos.discount',
    ]);
    expect(requiredOverrides([line(10)], 30, 20).permissions).toEqual([
      'pos.discount.override',
    ]);
  });

  it('needs pos.price.override when a line is not sold at its catalog price', () => {
    const check = requiredOverrides([line(8, 10)], 0, 20);
    expect(check.permissions).toEqual(['pos.price.override']);
    expect(check.reasons[0]).toBe('Line 1: price 10.00 → 8.00');
  });

  it('ignores sub-cent differences', () => {
    expect(requiredOverrides([line(10.001, 10)], 0, 20).permissions).toEqual(
      [],
    );
  });

  it('can need both a price and a discount override', () => {
    const check = requiredOverrides([line(8, 10), line(5, 5, 50)], 0, 20);
    expect(check.permissions.sort()).toEqual([
      'pos.discount.override',
      'pos.price.override',
    ]);
  });
});

describe('cartDiscountPercent', () => {
  const inputs: CalcLineInput[] = [
    { key: 'a', productId: 'p1', categoryId: null, quantity: 1, unitPrice: 40 },
    {
      key: 'b',
      productId: 'p2',
      categoryId: null,
      quantity: 2,
      unitPrice: 30,
      discountPercent: 50,
    },
  ];
  const base = { taxRate: 0, pricesIncludeTax: false };

  it('is the percentage itself for a percentage discount', () => {
    expect(
      cartDiscountPercent(inputs, {
        ...base,
        cartDiscount: { type: 'percentage', value: 12 },
      }),
    ).toBe(12);
  });

  it('converts a fixed amount into a percentage of the discounted cart', () => {
    // 40 + 60 − 30 (line discount) = 70; 14 off 70 = 20%
    expect(
      cartDiscountPercent(inputs, {
        ...base,
        cartDiscount: { type: 'fixed', value: 14 },
      }),
    ).toBe(20);
  });

  it('caps a fixed amount larger than the cart at 100%', () => {
    expect(
      cartDiscountPercent(inputs, {
        ...base,
        cartDiscount: { type: 'fixed', value: 500 },
      }),
    ).toBe(100);
  });

  it('is 0 without a cart discount', () => {
    expect(cartDiscountPercent(inputs, base)).toBe(0);
  });
});

describe('approvalRequired', () => {
  it('answers like the permissions guard so the POS can ask a manager', () => {
    const error = approvalRequired('pos.price.override', 'nope');
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toEqual({
      message: 'nope',
      error: 'Forbidden',
      missingPermissions: ['pos.price.override'],
      approvable: true,
    });
  });
});
