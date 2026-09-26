import {
  buildLabels,
  LabelSource,
  checkBarcode,
  gs1CheckDigit,
  isSoldAtBranch,
  MAX_TAGS,
  normalizeBarcode,
  normalizeTags,
  normalizeUnitCode,
  parseTagFilter,
  soldAtBranchSql,
  unitPrecision,
} from './catalog-rules';

describe('tags', () => {
  it('trims, collapses spaces, lower-cases and de-duplicates', () => {
    expect(
      normalizeTags([' Summer ', 'SUMMER', 'Cotton   Blend', '', '  ']),
    ).toEqual(['summer', 'cotton blend']);
    expect(normalizeTags(undefined)).toEqual([]);
  });

  it('caps the number and length of tags', () => {
    const many = Array.from({ length: 40 }, (_, i) => `tag-${i}`);
    expect(normalizeTags(many)).toHaveLength(MAX_TAGS);
    expect(normalizeTags(['x'.repeat(80)])[0]).toHaveLength(50);
  });

  it('parses the list filter from a query string', () => {
    expect(parseTagFilter('Summer, sale ,')).toEqual(['summer', 'sale']);
    expect(parseTagFilter(['A', 'b'])).toEqual(['a', 'b']);
    expect(parseTagFilter(undefined)).toEqual([]);
  });
});

describe('barcode normalization', () => {
  it('removes spaces, keeps leading zeros of numeric codes', () => {
    expect(normalizeBarcode(' 0 36000 29145 2 ')).toBe('036000291452');
    expect(normalizeBarcode('00123')).toBe('00123');
  });

  it('upper-cases codes with letters', () => {
    expect(normalizeBarcode(' abc-12 x')).toBe('ABC-12X');
  });

  it('turns blanks into null', () => {
    expect(normalizeBarcode('   ')).toBeNull();
    expect(normalizeBarcode(null)).toBeNull();
    expect(normalizeBarcode(undefined)).toBeNull();
  });
});

describe('barcode check digits (warning only)', () => {
  it('computes the GS1 check digit', () => {
    expect(gs1CheckDigit('501234567890')).toBe(0); // EAN-13 5012345678900
    expect(gs1CheckDigit('03600029145')).toBe(2); // UPC-A 036000291452
    expect(gs1CheckDigit('9638507')).toBe(4); // EAN-8 96385074
  });

  it('accepts valid EAN-13, UPC-A, EAN-8 and GTIN-14', () => {
    expect(checkBarcode('5012345678900')).toMatchObject({
      format: 'ean13',
      checkDigitValid: true,
      warning: null,
    });
    expect(checkBarcode('036000291452')).toMatchObject({
      format: 'upca',
      checkDigitValid: true,
    });
    expect(checkBarcode('96385074')).toMatchObject({
      format: 'ean8',
      checkDigitValid: true,
    });
    expect(checkBarcode('15012345678907')).toMatchObject({
      format: 'gtin14',
      checkDigitValid: true,
    });
  });

  it('warns about a wrong check digit without rejecting the code', () => {
    const result = checkBarcode('5012345678901');
    expect(result).toMatchObject({
      barcode: '5012345678901',
      format: 'ean13',
      checkDigitValid: false,
    });
    expect(result.warning).toMatch(/check digit/);
  });

  it('does not check other codes', () => {
    expect(checkBarcode('abc-1')).toEqual({
      barcode: 'ABC-1',
      format: 'other',
      checkDigitValid: null,
      warning: null,
    });
    expect(checkBarcode('12345')).toMatchObject({ checkDigitValid: null });
  });
});

describe('units of measure', () => {
  it('has no decimals for counted units', () => {
    expect(unitPrecision(false, 3)).toBe(0);
    expect(unitPrecision(true, undefined)).toBe(3);
    expect(unitPrecision(true, 9)).toBe(4);
    expect(unitPrecision(true, 0)).toBe(1);
  });

  it('normalizes unit codes', () => {
    expect(normalizeUnitCode(' K g ')).toBe('kg');
  });
});

describe('branch assortment', () => {
  it('sells a product without assortment everywhere', () => {
    expect(isSoldAtBranch([], 'b-1')).toBe(true);
    expect(isSoldAtBranch(null, 'b-1')).toBe(true);
  });

  it('only sells an assorted product at its branches', () => {
    expect(isSoldAtBranch(['b-1', 'b-2'], 'b-1')).toBe(true);
    expect(isSoldAtBranch(['b-1', 'b-2'], 'b-3')).toBe(false);
    // No register branch: nothing to filter on
    expect(isSoldAtBranch(['b-1'], null)).toBe(true);
  });

  it('builds the same rule as SQL for catalog queries', () => {
    const sql = soldAtBranchSql('p', 'branch');
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('pb_here."branchId" = :branch');
    expect(sql).toContain('pb_all."productId" = p.id');
  });
});

describe('labels', () => {
  const sources: (LabelSource & { cost?: number })[] = [
    {
      variantId: 'v-1',
      sku: 'MUG',
      barcode: '5012345678900',
      productName: { en: 'Mug', fr: 'Tasse' },
      variantName: null,
      price: 9.99,
      // A cost on the source never reaches a label
      cost: 3.2,
    },
    {
      variantId: 'v-2',
      sku: 'TEE-S',
      barcode: null,
      productName: { en: 'T-shirt' },
      variantName: { en: 'Small' },
      price: 15,
    },
  ];

  it('prints one label per copy with name, price and code (barcode, else SKU)', () => {
    const labels = buildLabels(
      sources,
      [
        { variantId: 'v-1', copies: 2 },
        { variantId: 'v-2', copies: 1 },
      ],
      'fr',
    );
    expect(labels).toHaveLength(3);
    expect(labels[0]).toEqual({
      variantId: 'v-1',
      name: 'Tasse',
      variantName: null,
      sku: 'MUG',
      code: '5012345678900',
      price: 9.99,
    });
    expect(labels[2]).toMatchObject({
      name: 'T-shirt',
      variantName: 'Small',
      code: 'TEE-S',
    });
  });

  it('never carries costs', () => {
    const labels = buildLabels(sources, [{ variantId: 'v-1', copies: 1 }]);
    expect(Object.keys(labels[0])).not.toContain('cost');
    expect(JSON.stringify(labels)).not.toContain('3.2');
  });
});
