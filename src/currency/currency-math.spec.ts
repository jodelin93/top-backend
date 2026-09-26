import {
  acceptedCurrencies,
  amountDueIn,
  changeIn,
  exchangeRate,
  toSaleCurrency,
} from './currency-math';

describe('currency math', () => {
  const rates = { HTG: 132.5 };

  it('converts between the store currency and accepted currencies', () => {
    expect(exchangeRate(rates, 'USD', 'USD', 'HTG')).toBe(132.5);
    expect(exchangeRate(rates, 'USD', 'HTG', 'USD')).toBeCloseTo(1 / 132.5);
    expect(exchangeRate(rates, 'USD', 'USD', 'USD')).toBe(1);
    expect(exchangeRate(rates, 'USD', 'USD', 'EUR')).toBeNull();
    expect(exchangeRate({ HTG: 0 }, 'USD', 'USD', 'HTG')).toBeNull();
  });

  it('converts through the store currency for a branch in another currency', () => {
    // Store in USD, branch sells in HTG, customer pays in EUR
    const r = exchangeRate({ HTG: 132.5, EUR: 0.9 }, 'USD', 'HTG', 'EUR');
    expect(r).toBeCloseTo(0.9 / 132.5);
  });

  it('lists the store currency first, then the others', () => {
    expect(acceptedCurrencies({ HTG: 132.5, EUR: 0.9 }, 'USD')).toEqual([
      'USD',
      'EUR',
      'HTG',
    ]);
    expect(acceptedCurrencies({ HTG: 0 }, 'USD')).toEqual(['USD']);
    expect(acceptedCurrencies(null, 'USD')).toEqual(['USD']);
  });

  it('asks for enough foreign money to cover the sale', () => {
    expect(amountDueIn(10, 132.5)).toBe(1325);
    expect(amountDueIn(7.33, 132.5)).toBe(971.23);
    // Store in HTG, paying in USD: 971.23 HTG at 0.00755 = 7.3328 → ask 7.34
    expect(amountDueIn(971.23, 0.00755)).toBe(7.34);
    expect(toSaleCurrency(7.34, 0.00755)).toBeGreaterThanOrEqual(971.23);
  });

  it('never hands back more change than owed', () => {
    expect(changeIn(2.5, 132.5)).toBe(331.25);
    expect(changeIn(0.337, 132.5)).toBe(44.65);
    expect(toSaleCurrency(changeIn(0.337, 132.5), 132.5)).toBeLessThanOrEqual(
      0.337,
    );
  });
});
