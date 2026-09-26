import { TaxCategoryRate, taxRateFor } from './tax-resolver.service';

describe('taxRateFor', () => {
  const categories = new Map<string, TaxCategoryRate>([
    ['food', { taxRateId: 'r-food', rate: 5, active: true }],
    ['exempt', { taxRateId: null, rate: null, active: false }],
    ['retired', { taxRateId: 'r-old', rate: 12, active: false }],
  ]);

  it('uses the store default for products without a tax category', () => {
    expect(taxRateFor(null, categories, 8.25)).toBe(8.25);
    expect(taxRateFor(undefined, categories, 8.25)).toBe(8.25);
  });

  it("uses the category's rate", () => {
    expect(taxRateFor('food', categories, 8.25)).toBe(5);
  });

  it('treats a category without a rate as exempt', () => {
    expect(taxRateFor('exempt', categories, 8.25)).toBe(0);
  });

  it('falls back to the store default when the category rate was deactivated', () => {
    expect(taxRateFor('retired', categories, 8.25)).toBe(8.25);
  });

  it('falls back to the store default for an unknown category', () => {
    expect(taxRateFor('missing', categories, 8.25)).toBe(8.25);
  });
});
