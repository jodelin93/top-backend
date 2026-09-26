import {
  cartesian,
  cleanValues,
  combinationKey,
  skuPart,
  uniqueSku,
} from './variant-generator';

describe('variant generator', () => {
  it('builds every combination in order', () => {
    const combos = cartesian([
      { attributeId: 'size', values: ['S', 'M'] },
      { attributeId: 'colour', values: ['Red', 'Blue'] },
    ]);
    expect(combos.map((c) => c.map((p) => p.value).join('/'))).toEqual([
      'S/Red',
      'S/Blue',
      'M/Red',
      'M/Blue',
    ]);
  });

  it('returns a single empty combination for no attributes', () => {
    expect(cartesian([])).toEqual([[]]);
  });

  it('makes SKU-safe fragments', () => {
    expect(skuPart('Extra Large')).toBe('EXTRALARGE');
    expect(skuPart('Café crème')).toBe('CAFECREME');
    expect(skuPart('???')).toBe('X');
  });

  it('identifies a combination regardless of attribute order or case', () => {
    expect(
      combinationKey([
        { attributeId: 'b', value: 'Red' },
        { attributeId: 'a', value: 'S ' },
      ]),
    ).toBe(
      combinationKey([
        { attributeId: 'a', value: 's' },
        { attributeId: 'b', value: 'red' },
      ]),
    );
  });

  it('suffixes SKUs that are already taken', () => {
    const taken = new Set(['TEE-S', 'TEE-S-2']);
    expect(uniqueSku('TEE-S', taken)).toBe('TEE-S-3');
    expect(uniqueSku('TEE-M', taken)).toBe('TEE-M');
    // The generated one is now taken too
    expect(uniqueSku('TEE-M', taken)).toBe('TEE-M-2');
  });

  it('cleans value lists', () => {
    expect(cleanValues([' S', 's', '', 'M '])).toEqual(['S', 'M']);
  });
});
