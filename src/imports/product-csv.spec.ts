import {
  CsvFormatError,
  MAX_IMPORT_ROWS,
  parseProductCsv,
  PRODUCT_CSV_TEMPLATE,
} from './product-csv';

describe('parseProductCsv', () => {
  it('parses the template without errors', () => {
    const { rows, unknownColumns } = parseProductCsv(PRODUCT_CSV_TEMPLATE);
    expect(unknownColumns).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.errors.length === 0)).toBe(true);
    expect(rows[0]).toMatchObject({
      line: 2,
      data: {
        sku: 'MUG-001',
        description: 'Ceramic, 350 ml',
        price: 9.99,
        cost: 3.2,
        reorderPoint: 10,
        productType: 'simple',
      },
    });
  });

  it('accepts friendly headers, a BOM and leaves blank cells unset', () => {
    const { rows } = parseProductCsv(
      '﻿SKU,Product Type,Tax-Category Code,Price\nA-1,Variable,,\n',
    );
    expect(rows[0].data).toEqual({ sku: 'A-1', productType: 'variable' });
    expect(rows[0].errors).toEqual([]);
  });

  it('reports every problem of a row', () => {
    const { rows } = parseProductCsv(
      'sku,price,reorder_point,allow_backorder,status,product_type\n,-1,2.5,maybe,gone,bundle',
    );
    expect(rows[0].errors).toEqual([
      'sku is required',
      'price must be a positive number (got "-1")',
      'reorder_point must be a whole number (got "2.5")',
      'product_type must be one of simple, variable, composite (got "bundle")',
      'status must be one of active, inactive, discontinued (got "gone")',
    ]);
  });

  it('accepts the allow_backorder column but ignores its value (D018)', () => {
    const { rows, unknownColumns } = parseProductCsv(
      'sku,allow_backorder\nA,true\nB,maybe',
    );
    expect(unknownColumns).toEqual([]);
    expect(rows.map((r) => r.errors)).toEqual([[], []]);
    expect(rows.map((r) => r.data)).toEqual([{ sku: 'A' }, { sku: 'B' }]);
  });

  it('rounds money to cents and flags extra cells', () => {
    const { rows } = parseProductCsv('sku,price\nA,1.005,extra');
    expect(rows[0].data.price).toBe(1);
    expect(rows[0].errors).toContain('More cells than header columns');
  });

  it('lists unknown columns', () => {
    expect(parseProductCsv('sku,colour\nA,red').unknownColumns).toEqual([
      'colour',
    ]);
  });

  it('rejects files that are not a product CSV', () => {
    expect(() => parseProductCsv('')).toThrow(CsvFormatError);
    expect(() => parseProductCsv('name,price\nx,1')).toThrow('"sku" column');
    expect(() => parseProductCsv('sku,SKU\nA,B')).toThrow('Duplicate columns');
    expect(() => parseProductCsv('sku\n')).toThrow('no product rows');
    expect(() => parseProductCsv('sku,name\n"unterminated,x')).toThrow(
      'Could not read',
    );
    const tooMany = [
      'sku',
      ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `S${i}`),
    ];
    expect(() => parseProductCsv(tooMany.join('\n'))).toThrow('at most');
  });
});
