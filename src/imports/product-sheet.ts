import { inflateRawSync } from 'node:zlib';
import * as ExcelJS from 'exceljs';
import { CsvFormatError, MAX_IMPORT_ROWS } from './product-csv';

/**
 * Product import from an Excel workbook (.xlsx): the first sheet is read into the
 * same rows of text as a CSV file, then checked by the same rules.
 */

// An .xlsx file is a zip archive; the old binary .xls format is not read
export const isXlsx = (file: Buffer) =>
  file.length > 4 &&
  file[0] === 0x50 &&
  file[1] === 0x4b &&
  file[2] === 0x03 &&
  file[3] === 0x04;
export const isOldExcel = (file: Buffer) =>
  file.length > 8 &&
  file
    .subarray(0, 8)
    .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

// What the archive may unpack to: far more than 5,000 product rows ever need,
// far less than a "zip bomb" could ask for
export const MAX_XLSX_UNPACKED_BYTES = 40 * 1024 * 1024;

/**
 * Total unpacked size of a zip archive, from its central directory (read before
 * anything is unpacked); null when the archive can't be read that way.
 */
export function zipUnpackedSize(file: Buffer): number | null {
  // End of central directory: at least 22 bytes, at most 64 KB of comment after it
  const from = Math.max(0, file.length - 22 - 0xffff);
  let end = -1;
  for (let i = file.length - 22; i >= from; i--) {
    if (file.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const entries = file.readUInt16LE(end + 10);
  let offset = file.readUInt32LE(end + 16);
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > file.length || file.readUInt32LE(offset) !== 0x02014b50) {
      return null;
    }
    const size = file.readUInt32LE(offset + 24);
    // 0xffffffff: a zip64 entry, larger than this import ever accepts
    if (size === 0xffffffff) return null;
    total += size;
    offset +=
      46 +
      file.readUInt16LE(offset + 28) +
      file.readUInt16LE(offset + 30) +
      file.readUInt16LE(offset + 32);
  }
  return total;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A cell as the text a CSV file would hold */
export function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    // Long barcodes typed as numbers: all their digits, never 1e+21
    return Math.abs(value) >= 1e21
      ? value.toLocaleString('fullwide', { useGrouping: false })
      : String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`;
  }
  if ('richText' in value)
    return value.richText.map((part) => part.text).join('');
  if ('result' in value) return cellText(value.result);
  if ('hyperlink' in value) return String(value.text ?? value.hyperlink);
  // Errors (#N/A...) and anything else: empty
  return '';
}

/**
 * Does the archive really unpack within `limit` bytes? Each entry is inflated
 * with an output cap (never more memory than the limit), because the sizes a
 * zip declares can lie. null: the archive can't be read that way.
 */
export function zipFitsWithin(file: Buffer, limit: number): boolean | null {
  const from = Math.max(0, file.length - 22 - 0xffff);
  let end = -1;
  for (let i = file.length - 22; i >= from; i--) {
    if (file.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return null;
  const entries = file.readUInt16LE(end + 10);
  let offset = file.readUInt32LE(end + 16);
  let left = limit;
  for (let n = 0; n < entries; n++) {
    if (offset + 46 > file.length || file.readUInt32LE(offset) !== 0x02014b50) {
      return null;
    }
    const method = file.readUInt16LE(offset + 10);
    const compressed = file.readUInt32LE(offset + 20);
    const local = file.readUInt32LE(offset + 42);
    if (compressed === 0xffffffff || local + 30 > file.length) return null;
    if (file.readUInt32LE(local) !== 0x04034b50) return null;
    const start =
      local +
      30 +
      file.readUInt16LE(local + 26) +
      file.readUInt16LE(local + 28);
    if (start + compressed > file.length) return null;
    const data = file.subarray(start, start + compressed);
    if (method === 0) {
      left -= compressed;
    } else if (method === 8) {
      try {
        left -= inflateRawSync(data, { maxOutputLength: left + 1 }).length;
      } catch (error) {
        // Over the cap, or not deflate data at all
        if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
          return false;
        }
        return null;
      }
    } else {
      return null;
    }
    if (left < 0) return false;
    offset +=
      46 +
      file.readUInt16LE(offset + 28) +
      file.readUInt16LE(offset + 30) +
      file.readUInt16LE(offset + 32);
  }
  return true;
}

/** The first sheet of an .xlsx workbook as rows of text (empty rows left out) */
export async function readProductSheet(file: Buffer): Promise<string[][]> {
  const unpacked = zipUnpackedSize(file);
  if (unpacked === null) {
    throw new CsvFormatError('Could not read the Excel file');
  }
  // What it declares, then what it really unpacks to (a declared size can lie)
  const fits =
    unpacked <= MAX_XLSX_UNPACKED_BYTES
      ? zipFitsWithin(file, MAX_XLSX_UNPACKED_BYTES)
      : false;
  if (fits === null) {
    throw new CsvFormatError('Could not read the Excel file');
  }
  if (!fits) {
    throw new CsvFormatError(
      'The Excel file is too large. Split it into smaller files.',
    );
  }
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file as unknown as ArrayBuffer);
  } catch {
    throw new CsvFormatError('Could not read the Excel file');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new CsvFormatError('The file is empty');
  if (sheet.actualRowCount > MAX_IMPORT_ROWS + 1) {
    throw new CsvFormatError(
      `The file has ${sheet.actualRowCount - 1} rows; import at most ${MAX_IMPORT_ROWS} at a time`,
    );
  }
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    for (let col = 1; col <= row.cellCount; col++) {
      cells.push(cellText(row.getCell(col).value).trim());
    }
    if (cells.some((cell) => cell !== '')) rows.push(cells);
  });
  return rows;
}

/** The import template as an Excel workbook: every cell is text */
export async function templateXlsx(records: string[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');
  records.forEach((cells) => {
    const row = sheet.addRow(cells);
    // Text format: SKUs and barcodes keep their leading zeros
    row.eachCell((cell) => (cell.numFmt = '@'));
  });
  sheet.getRow(1).font = { bold: true };
  sheet.columns.forEach((column, i) => {
    column.width = Math.max(12, (records[0][i] ?? '').length + 4);
  });
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
