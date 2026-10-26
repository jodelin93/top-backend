import { deflateRawSync } from 'node:zlib';
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
  zipFitsWithin,
  MAX_XLSX_UNPACKED_BYTES,
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

describe('zipFitsWithin (what an archive really unpacks to)', () => {
  // A one-entry zip whose central directory declares `declared` bytes unpacked
  const zipOf = (content: Buffer, declared: number) => {
    const data = deflateRawSync(content);
    const name = Buffer.from('xl/sheet1.xml');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const centralStart = local.length + name.length + data.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + name.length, 12);
    end.writeUInt32LE(centralStart, 16);
    return Buffer.concat([local, name, data, central, name, end]);
  };

  it('accepts an archive that unpacks within the limit', () => {
    expect(zipFitsWithin(zipOf(Buffer.alloc(1000, 'a'), 1000), 10_000)).toBe(
      true,
    );
  });

  it('refuses an archive that lies about its size, without unpacking it all', () => {
    // 50 MB of zeros, a few KB packed, declared as 10 bytes
    const bomb = zipOf(Buffer.alloc(50 * 1024 * 1024), 10);
    expect(bomb.length).toBeLessThan(200_000);
    expect(zipUnpackedSize(bomb)).toBe(10);
    expect(zipFitsWithin(bomb, MAX_XLSX_UNPACKED_BYTES)).toBe(false);
  });
});
