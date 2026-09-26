import {
  ean13CheckDigit,
  normalizePlu,
  parseWeightedBarcode,
  scannedQuantity,
  WeightedBarcodeSettings,
} from './weighted-barcode';

const PREFIXES = ['20', '21', '22', '23', '24', '25', '26', '27', '28', '29'];
const WEIGHT: WeightedBarcodeSettings = {
  prefixes: PREFIXES,
  layout: 'weight',
  itemCodeLength: 5,
  valueDecimals: 3,
};
const PRICE: WeightedBarcodeSettings = {
  ...WEIGHT,
  layout: 'price',
  valueDecimals: 2,
};

/** EAN-13 with a correct check digit */
const ean = (body12: string) => `${body12}${ean13CheckDigit(body12)}`;

describe('parseWeightedBarcode', () => {
  it('reads PLU and weight (grams → kg)', () => {
    // 21 | 01234 | 01250 | C
    const code = ean('210123401250');
    expect(parseWeightedBarcode(code, WEIGHT)).toEqual({
      ok: true,
      prefix: '21',
      itemCode: '01234',
      plu: '1234',
      layout: 'weight',
      value: 1.25,
    });
  });

  it('reads PLU and price', () => {
    const code = ean('200004200499');
    expect(parseWeightedBarcode(code, PRICE)).toMatchObject({
      ok: true,
      plu: '42',
      layout: 'price',
      value: 4.99,
    });
  });

  it('validates the EAN-13 check digit', () => {
    const good = ean('210123401250');
    const bad = `${good.slice(0, 12)}${(Number(good[12]) + 1) % 10}`;
    expect(parseWeightedBarcode(bad, WEIGHT)).toEqual({
      ok: false,
      error: 'check_digit',
    });
  });

  it('ignores codes that are not variable measure labels', () => {
    // Feature off (no prefixes)
    expect(
      parseWeightedBarcode(ean('210123401250'), { ...WEIGHT, prefixes: [] }),
    ).toBeNull();
    // Ordinary EAN-13 (prefix not configured)
    expect(parseWeightedBarcode('5012345678900', WEIGHT)).toBeNull();
    // Not 13 digits
    expect(parseWeightedBarcode('2101234', WEIGHT)).toBeNull();
    expect(parseWeightedBarcode('ABC', WEIGHT)).toBeNull();
    // Only the configured prefixes
    expect(
      parseWeightedBarcode(ean('290123401250'), {
        ...WEIGHT,
        prefixes: ['21'],
      }),
    ).toBeNull();
  });

  it('supports other item code lengths', () => {
    // 4-digit PLU, 6-digit value
    const code = ean('211234001250');
    expect(
      parseWeightedBarcode(code, { ...WEIGHT, itemCodeLength: 4 }),
    ).toMatchObject({ plu: '1234', value: 1.25 });
  });
});

describe('scannedQuantity', () => {
  const scan = (code: string, settings: WeightedBarcodeSettings) => {
    const result = parseWeightedBarcode(code, settings);
    if (!result?.ok) throw new Error('not a weighted code');
    return result;
  };

  it('weight layout: the weight at the unit precision', () => {
    expect(scannedQuantity(scan(ean('210123401250'), WEIGHT), 3.99, 3)).toEqual(
      { quantity: 1.25, amount: null },
    );
    // A 1-decimal unit rounds the weight
    expect(
      scannedQuantity(scan(ean('210123401250'), WEIGHT), 3.99, 1).quantity,
    ).toBe(1.3);
    // Zero weight: nothing to sell
    expect(
      scannedQuantity(scan(ean('210123400000'), WEIGHT), 3.99, 3).quantity,
    ).toBeNull();
  });

  it('price layout: label price ÷ unit price, charging exactly the label', () => {
    // 4.99 at 3.99/kg = 1.2506… kg; 1.251 kg × 3.99 = 4.99149 → 4.99
    const result = scannedQuantity(scan(ean('210123400499'), PRICE), 3.99, 3);
    expect(result.amount).toBe(4.99);
    expect(result.quantity).toBe(1.251);
    expect(Math.round(result.quantity! * 3.99 * 100)).toBe(499);
  });

  it('price layout without a unit price cannot give a quantity', () => {
    expect(
      scannedQuantity(scan(ean('210123400499'), PRICE), 0, 3).quantity,
    ).toBeNull();
  });
});

describe('normalizePlu', () => {
  it('keeps digits without leading zeros', () => {
    expect(normalizePlu('01234')).toBe('1234');
    expect(normalizePlu(' 42 ')).toBe('42');
    expect(normalizePlu('0')).toBe('0');
    expect(normalizePlu('12a')).toBeNull();
    expect(normalizePlu('1234567')).toBeNull();
  });
});
