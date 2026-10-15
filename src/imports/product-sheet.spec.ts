import * as ExcelJS from 'exceljs';
import { parse } from 'csv-parse/sync';
import { parseProductRecords, PRODUCT_CSV_TEMPLATE } from './product-csv';
import {
  cellText,
  isOldExcel,
  isXlsx,
  readProductSheet,
  templateXlsx,
  zipUnpackedSize,
} from './product-sheet';

async function workbook(rows: ExcelJS.CellValue[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('Products');
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await book.xlsx.writeBuffer());
}

describe('product import from Excel (.xlsx)', () => {
  it('reads the first sheet like a CSV file, numbers and barcodes included', async () => {
    const file = await workbook([
      ['sku', 'name', 'barcode', 'price', 'cost', 'status'],
      ['MUG-001', 'Coffee mug', 5012345678900, 9.99, 3.2, 'active'],
      [],
      [
        'TEE-001',
        { richText: [{ text: 'T-' }, { text: 'shirt' }] },
        null,
        12,
        null,
        'active',
      ],
    ]);
    expect(isXlsx(file)).toBe(true);
    const records = await readProductSheet(file);
    expect(records).toEqual([
      ['sku', 'name', 'barcode', 'price', 'cost', 'status'],
      ['MUG-001', 'Coffee mug', '5012345678900', '9.99', '3.2', 'active'],
      ['TEE-001', 'T-shirt', '', '12', '', 'active'],
    ]);
    const parsed = parseProductRecords(records);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.unknownColumns).toEqual([]);
  });

  it('gives an Excel template that reads back as the CSV template', async () => {
    const template = parse(PRODUCT_CSV_TEMPLATE);
    const file = await templateXlsx(template);
    // Empty template cells are simply absent: compare without trailing blanks
    const trim = (rows: string[][]) =>
      rows.map((r) => {
        const out = [...r];
        while (out.length && out[out.length - 1] === '') out.pop();
        return out;
      });
    expect(trim(await readProductSheet(file))).toEqual(trim(template));
  });

  it('writes cells the way a CSV file holds them', () => {
    expect(cellText(null)).toBe('');
    expect(cellText(true)).toBe('true');
    expect(cellText(1e21)).toBe('1000000000000000000000');
    expect(cellText(new Date(Date.UTC(2026, 9, 15)))).toBe('2026-10-15');
    expect(cellText({ formula: 'A1*2', result: 19.98 })).toBe('19.98');
    expect(cellText({ error: '#N/A' })).toBe('');
  });

  it('measures the archive before unpacking it, and knows the old .xls format', async () => {
    const file = await workbook([['sku'], ['A-1']]);
    const size = zipUnpackedSize(file);
    expect(size).toBeGreaterThan(file.length);
    expect(zipUnpackedSize(Buffer.from('sku,name\nA-1,Mug'))).toBeNull();
    expect(
      isOldExcel(
        Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0]),
      ),
    ).toBe(true);
    expect(isXlsx(Buffer.from('sku,name'))).toBe(false);
  });

  it('refuses a file it cannot read', async () => {
    const broken = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.alloc(64),
    ]);
    await expect(readProductSheet(broken)).rejects.toThrow(
      'Could not read the Excel file',
    );
  });
});
