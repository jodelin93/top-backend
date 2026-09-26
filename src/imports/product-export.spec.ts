import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';
import { PRODUCT_CSV_COLUMNS, parseProductCsv } from './product-csv';
import { ExportProduct, exportColumns, toCsv, toXlsx } from './product-export';

const mug: ExportProduct = {
  sku: 'MUG-001',
  name: { en: 'Coffee mug, "large"' },
  description: { en: 'Ceramic' },
  categoryCode: 'KITCHEN',
  brand: 'Acme',
  barcode: '0036000291452',
  price: '9.9900',
  cost: '3.2000',
  taxCategoryCode: 'STANDARD',
  productType: 'simple',
  reorderPoint: 10,
  minStockLevel: null,
  allowBackorder: false,
  status: 'active',
};

describe('product export', () => {
  it('uses the import template columns, in order', () => {
    expect(exportColumns(true)).toEqual([...PRODUCT_CSV_COLUMNS]);
  });

  it('leaves the cost column out for people who may not see costs', () => {
    expect(exportColumns(false)).not.toContain('cost');
    const csv = toCsv([mug], { includeCost: false }).toString('utf8');
    expect(csv.split('\r\n')[0]).not.toContain('cost');
    expect(csv).not.toContain('3.20');
  });

  it('neutralises spreadsheet formulas in text cells', () => {
    const csv = toCsv(
      [
        {
          ...mug,
          name: { en: '=HYPERLINK("http://evil","x")' },
          brand: '@SUM(A1)',
        },
      ],
      { includeCost: true },
    ).toString('utf8');
    const row = csv.split('\r\n')[1];
    expect(row).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(row).toContain(`'@SUM(A1)`);
    // Negative prices are numbers, not formulas
    expect(
      toCsv([{ ...mug, price: -5 }], { includeCost: true }).toString(),
    ).toContain(',-5.00,');
  });

  it('writes a CSV the import reads back (quotes, leading zeros)', () => {
    const csv = toCsv([mug], { includeCost: true });
    const { rows, unknownColumns } = parseProductCsv(csv);
    expect(unknownColumns).toEqual([]);
    expect(rows[0].errors).toEqual([]);
    expect(rows[0].data).toMatchObject({
      sku: 'MUG-001',
      name: 'Coffee mug, "large"',
      barcode: '0036000291452',
      price: 9.99,
      cost: 3.2,
      reorderPoint: 10,
    });
  });

  it('writes an Excel workbook', async () => {
    const xlsx = await toXlsx([mug], { includeCost: false });
    // ZIP signature
    expect(xlsx.subarray(0, 2).toString()).toBe('PK');
  });
});

describe('GET /imports/products/export', () => {
  const run = async (permissions: string[]) => {
    const exportFn = jest.fn(() =>
      Promise.resolve({
        body: Buffer.from(''),
        contentType: 'text/csv',
        filename: 'p.csv',
      }),
    );
    const controller = new ImportsController({
      export: exportFn,
    } as unknown as ImportsService);
    const res = { set: jest.fn() };
    await controller.export(
      'tenant-1',
      { id: 'u', permissions } as unknown as AuthUser,
      { format: 'csv' },
      res as never,
    );
    return exportFn.mock.calls[0] as unknown[];
  };

  it('includes costs only with inventory.cost.view (or purchasing)', async () => {
    expect((await run(['catalog.import']))[2]).toEqual({ includeCost: false });
    expect((await run(['catalog.import', 'inventory.cost.view']))[2]).toEqual({
      includeCost: true,
    });
  });

  it('needs catalog.import', () => {
    expect(new Reflector().get(PERMISSIONS_KEY, ImportsController)).toEqual([
      'catalog.import',
    ]);
  });
});
