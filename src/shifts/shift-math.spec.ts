import { BadRequestException } from '@nestjs/common';
import {
  evaluateForeignCash,
  checkCloseAuthority,
  countTotal,
  defaultDenominations,
  evaluateVariance,
  expectedCash,
  foreignOpeningFloats,
  normalizeDenominations,
  withOpeningForeign,
} from './shift-math';

const base = {
  openingFloat: 100,
  cashSales: 0,
  changeGiven: 0,
  paidIn: 0,
  paidOut: 0,
  safeDrops: 0,
  expensePayouts: 0,
  cashRefunds: 0,
  foreign: [],
};

describe('expectedCash', () => {
  it('is the float when nothing happened', () => {
    expect(expectedCash(base)).toBe(100);
  });

  it('adds cash sales and paid-in, subtracts change and every payout', () => {
    expect(
      expectedCash({
        openingFloat: 100,
        cashSales: 250.4,
        changeGiven: 12.15,
        paidIn: 20,
        paidOut: 5.5,
        safeDrops: 200,
        expensePayouts: 15.25,
        cashRefunds: 9.99,
        foreign: [],
      }),
    ).toBe(127.51);
  });

  it('rounds to cents without floating point noise', () => {
    expect(expectedCash({ ...base, openingFloat: 0.1, cashSales: 0.2 })).toBe(
      0.3,
    );
  });
});

describe('countTotal', () => {
  it('sums value × quantity', () => {
    expect(
      countTotal([
        { value: 20, quantity: 3 },
        { value: 0.25, quantity: 7 },
        { value: 0.01, quantity: 3 },
      ]),
    ).toBe(61.78);
  });

  it('rejects fractional or negative quantities', () => {
    expect(() => countTotal([{ value: 5, quantity: 1.5 }])).toThrow(
      BadRequestException,
    );
    expect(() => countTotal([{ value: 5, quantity: -1 }])).toThrow(
      BadRequestException,
    );
  });
});

describe('evaluateVariance', () => {
  it('negative variance means the drawer is short', () => {
    expect(evaluateVariance(95, 100, 5)).toMatchObject({
      variance: -5,
      overTolerance: false,
    });
  });

  it('is over tolerance only when strictly above it', () => {
    expect(evaluateVariance(105.01, 100, 5).overTolerance).toBe(true);
    expect(evaluateVariance(105, 100, 5).overTolerance).toBe(false);
    expect(evaluateVariance(100.01, 100, 0).overTolerance).toBe(true);
  });
});

describe('checkCloseAuthority', () => {
  const input = {
    overTolerance: true,
    varianceReason: 'miscount',
    closerCanManage: false,
    approverId: null,
    closerId: 'cashier',
  };

  it('allows any close within tolerance', () => {
    expect(
      checkCloseAuthority({
        ...input,
        overTolerance: false,
        varianceReason: null,
      }),
    ).toEqual({ ok: true, approverId: null });
  });

  it('requires a reason over tolerance, even for managers', () => {
    expect(
      checkCloseAuthority({
        ...input,
        varianceReason: '  ',
        closerCanManage: true,
      }),
    ).toMatchObject({ ok: false, code: 'reason_required' });
  });

  it('requires shifts.manage or an approval over tolerance', () => {
    expect(checkCloseAuthority(input)).toMatchObject({
      ok: false,
      code: 'approval_required',
    });
    expect(checkCloseAuthority({ ...input, closerCanManage: true })).toEqual({
      ok: true,
      approverId: null,
    });
    expect(checkCloseAuthority({ ...input, approverId: 'manager' })).toEqual({
      ok: true,
      approverId: 'manager',
    });
  });

  it('never accepts the closer as their own approver', () => {
    expect(
      checkCloseAuthority({ ...input, approverId: 'cashier' }),
    ).toMatchObject({ ok: false, code: 'approval_required' });
  });
});

describe('denominations', () => {
  it('has defaults for the supported currencies', () => {
    for (const code of ['USD', 'EUR', 'CAD', 'HTG', 'GBP']) {
      expect(defaultDenominations(code).length).toBeGreaterThan(5);
    }
    expect(defaultDenominations('xyz').length).toBeGreaterThan(0);
  });

  it('normalizes custom lists: dedupe and sort largest first', () => {
    expect(normalizeDenominations([1, 100, 0.25, 100])).toEqual([100, 1, 0.25]);
    expect(() => normalizeDenominations([0])).toThrow(BadRequestException);
  });
});

describe('evaluateForeignCash', () => {
  const htg = {
    currencyCode: 'HTG',
    cashSales: 2650,
    changeGiven: 150,
    expected: 2500,
  };
  const rate = () => 132.5;

  it('compares each currency with its own expected amount', () => {
    const [r] = evaluateForeignCash(
      [htg],
      [{ currencyCode: 'htg', countedCash: 2500 }],
      rate,
      5,
    );
    expect(r).toMatchObject({
      currencyCode: 'HTG',
      expected: 2500,
      counted: 2500,
      variance: 0,
      overTolerance: false,
    });
  });

  it('weighs the variance in the store currency against the tolerance', () => {
    // 500 HTG short = 3.77 USD: within a 5.00 tolerance
    expect(
      evaluateForeignCash(
        [htg],
        [{ currencyCode: 'HTG', countedCash: 2000 }],
        rate,
        5,
      )[0].overTolerance,
    ).toBe(false);
    // 1000 HTG short = 7.55 USD: over
    expect(
      evaluateForeignCash(
        [htg],
        [{ currencyCode: 'HTG', countedCash: 1500 }],
        rate,
        5,
      )[0],
    ).toMatchObject({ variance: -1000, overTolerance: true });
  });

  it('requires every currency the drawer took to be counted', () => {
    expect(() => evaluateForeignCash([htg], [], rate, 5)).toThrow(
      'Count the HTG cash',
    );
    expect(evaluateForeignCash([], undefined, rate, 5)).toEqual([]);
  });
});

describe('withOpeningForeign', () => {
  it('adds the opening foreign float to the expected cash per currency', () => {
    expect(
      withOpeningForeign(
        [
          {
            currencyCode: 'EUR',
            cashSales: 50,
            changeGiven: 5,
            expected: 45,
          },
        ],
        [
          { currencyCode: 'eur', amount: 20 },
          { currencyCode: 'GBP', amount: 10 },
          { currencyCode: 'CAD', amount: 0 },
        ],
      ),
    ).toEqual([
      {
        currencyCode: 'EUR',
        openingFloat: 20,
        cashSales: 50,
        changeGiven: 5,
        expected: 65,
      },
      // Only in the opening float: still expected (and counted) at close
      {
        currencyCode: 'GBP',
        openingFloat: 10,
        cashSales: 0,
        changeGiven: 0,
        expected: 10,
      },
    ]);
  });

  it('leaves the sales figures alone without an opening float', () => {
    expect(
      withOpeningForeign(
        [{ currencyCode: 'EUR', cashSales: 10, changeGiven: 0, expected: 10 }],
        null,
      ),
    ).toEqual([
      {
        currencyCode: 'EUR',
        openingFloat: 0,
        cashSales: 10,
        changeGiven: 0,
        expected: 10,
      },
    ]);
  });
});

describe('foreignOpeningFloats', () => {
  const rates = { HTG: 132.5 };

  it('keeps accepted currencies, rounded, and drops zero amounts', () => {
    expect(
      foreignOpeningFloats(
        [{ currencyCode: 'htg', amount: 2500.004 }],
        'USD',
        rates,
      ),
    ).toEqual([{ currencyCode: 'HTG', amount: 2500 }]);
    expect(
      foreignOpeningFloats([{ currencyCode: 'HTG', amount: 0 }], 'USD', rates),
    ).toEqual([]);
    expect(foreignOpeningFloats(undefined, 'USD', rates)).toEqual([]);
  });

  it('refuses the store currency, unknown currencies and duplicates', () => {
    expect(() =>
      foreignOpeningFloats([{ currencyCode: 'USD', amount: 5 }], 'USD', rates),
    ).toThrow(BadRequestException);
    expect(() =>
      foreignOpeningFloats([{ currencyCode: 'EUR', amount: 5 }], 'USD', rates),
    ).toThrow(BadRequestException);
    expect(() =>
      foreignOpeningFloats(
        [
          { currencyCode: 'HTG', amount: 5 },
          { currencyCode: 'htg', amount: 6 },
        ],
        'USD',
        rates,
      ),
    ).toThrow(BadRequestException);
  });
});
