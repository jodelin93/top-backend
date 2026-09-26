import {
  allocateToOriginalTenders,
  lineRefund,
  onAccountShare,
  saleAgeDays,
} from './return-math';

describe('lineRefund', () => {
  // 3 units: subtotal 10.00, discount 1.00, tax 0.90, total 9.90
  const line = {
    quantity: 3,
    subtotal: 10,
    discountAmount: 1,
    taxAmount: 0.9,
    total: 9.9,
  };

  it('refunds a single unit proportionally', () => {
    expect(lineRefund(line, 0, 1)).toEqual({
      subtotal: 3.33,
      discountAmount: 0.33,
      taxAmount: 0.3,
      total: 3.3,
    });
  });

  it('adds up to exactly the original line over several partial returns', () => {
    const parts = [
      lineRefund(line, 0, 1),
      lineRefund(line, 1, 1),
      lineRefund(line, 2, 1),
    ];
    const sum = (key: 'subtotal' | 'discountAmount' | 'taxAmount' | 'total') =>
      Math.round(parts.reduce((acc, p) => acc + p[key], 0) * 100) / 100;
    expect(sum('subtotal')).toBe(10);
    expect(sum('discountAmount')).toBe(1);
    expect(sum('taxAmount')).toBe(0.9);
    expect(sum('total')).toBe(9.9);
  });

  it('refunds the whole line at once', () => {
    expect(lineRefund(line, 0, 3)).toEqual({
      subtotal: 10,
      discountAmount: 1,
      taxAmount: 0.9,
      total: 9.9,
    });
  });

  it('rejects returning more than was sold', () => {
    expect(() => lineRefund(line, 2, 2)).toThrow(RangeError);
    expect(() => lineRefund(line, 0, 0)).toThrow(RangeError);
  });
});

describe('allocateToOriginalTenders', () => {
  const card = {
    paymentId: 'p-card',
    paymentMethodId: 'm-card',
    isCash: false,
    amount: 20,
    refunded: 0,
  };
  const cash = {
    paymentId: 'p-cash',
    paymentMethodId: 'm-cash',
    isCash: true,
    amount: 10,
    refunded: 0,
  };

  it('refunds card before cash', () => {
    expect(allocateToOriginalTenders(25, [cash, card])).toEqual([
      { paymentId: 'p-card', paymentMethodId: 'm-card', amount: 20 },
      { paymentId: 'p-cash', paymentMethodId: 'm-cash', amount: 5 },
    ]);
  });

  it('skips what earlier returns already refunded', () => {
    expect(
      allocateToOriginalTenders(5, [{ ...card, refunded: 18 }, cash]),
    ).toEqual([
      { paymentId: 'p-card', paymentMethodId: 'm-card', amount: 2 },
      { paymentId: 'p-cash', paymentMethodId: 'm-cash', amount: 3 },
    ]);
  });

  it('refuses a refund larger than what was paid', () => {
    expect(() => allocateToOriginalTenders(31, [card, cash])).toThrow(
      RangeError,
    );
  });
});

describe('onAccountShare', () => {
  const sale = { saleTotal: 100, paidOnAccount: 60 };

  it('takes a return off the account in proportion to what went on it', () => {
    expect(
      onAccountShare({
        ...sale,
        creditedSoFar: 0,
        refundedSoFar: 0,
        refund: 50,
      }),
    ).toBe(30);
  });

  it('adds up exactly over several partial returns', () => {
    const first = onAccountShare({
      ...sale,
      creditedSoFar: 0,
      refundedSoFar: 0,
      refund: 33.33,
    });
    const second = onAccountShare({
      ...sale,
      creditedSoFar: first,
      refundedSoFar: 33.33,
      refund: 33.33,
    });
    const third = onAccountShare({
      ...sale,
      creditedSoFar: Math.round((first + second) * 100) / 100,
      refundedSoFar: 66.66,
      refund: 33.34,
    });
    expect(Math.round((first + second + third) * 100) / 100).toBe(60);
  });

  it('never credits more than the account carries for the sale', () => {
    expect(
      onAccountShare({
        ...sale,
        creditedSoFar: 55,
        refundedSoFar: 0,
        refund: 100,
      }),
    ).toBe(5);
  });
});

describe('lineRefund of a measured (weighed) line', () => {
  // 1.250 kg × 3.99 = 4.99; 8.25% tax 0.41; total 5.40
  const weighed = {
    quantity: 1.25,
    subtotal: 4.99,
    discountAmount: 0,
    taxAmount: 0.41,
    total: 5.4,
  };

  it('prorates a partial return of 0.5 kg exactly', () => {
    // 0.5 / 1.25 = 40%: 1.996 → 2.00, 0.164 → 0.16, 2.16
    expect(lineRefund(weighed, 0, 0.5)).toEqual({
      subtotal: 2,
      discountAmount: 0,
      taxAmount: 0.16,
      total: 2.16,
    });
  });

  it('refunds the rest so both returns add up to the line', () => {
    const first = lineRefund(weighed, 0, 0.5);
    const rest = lineRefund(weighed, 0.5, 0.75);
    expect(rest).toEqual({
      subtotal: 2.99,
      discountAmount: 0,
      taxAmount: 0.25,
      total: 3.24,
    });
    expect(Math.round((first.total + rest.total) * 100)).toBe(540);
  });

  it('adds up exactly over many small returns (no floating point drift)', () => {
    let returned = 0;
    let cents = 0;
    for (let i = 0; i < 125; i++) {
      cents += Math.round(lineRefund(weighed, returned, 0.01).total * 100);
      returned = Math.round((returned + 0.01) * 10000) / 10000;
    }
    expect(returned).toBe(1.25);
    expect(cents).toBe(540);
  });

  it('refuses more than was weighed', () => {
    expect(() => lineRefund(weighed, 1, 0.2501)).toThrow(RangeError);
  });
});

describe('saleAgeDays (return window)', () => {
  const now = Date.UTC(2026, 5, 30);
  const daysAgo = (n: number) => new Date(now - n * 86_400_000);

  it('counts from the sale date of an offline sale uploaded later', () => {
    expect(
      saleAgeDays({ saleDate: daysAgo(10), createdAt: daysAgo(2) }, now),
    ).toBe(10);
  });

  it('ignores a sale date after the server recorded the sale', () => {
    // Set in the future to keep the sale returnable forever
    expect(
      saleAgeDays({ saleDate: daysAgo(-365), createdAt: daysAgo(40) }, now),
    ).toBe(40);
  });

  it('is never negative', () => {
    expect(saleAgeDays({ saleDate: daysAgo(-3) }, now)).toBe(0);
    expect(
      saleAgeDays({ saleDate: daysAgo(-3), createdAt: daysAgo(-1) }, now),
    ).toBe(0);
  });
});
