import { parse } from 'csv-parse/sync';
import { normalizeBarcode } from '../products/catalog-rules';
import {
  ProductStatus,
  ProductType,
} from '../database/entities/product.entity';

/**
 * CSV format of the product import. Header names are case-insensitive;
 * spaces and dashes count as underscores ("Tax category code" = tax_category_code).
 * A blank cell leaves the current value unchanged when updating.
 */
export const PRODUCT_CSV_COLUMNS = [
  'sku',
  'name',
  'description',
  'category_code',
  'brand',
  'barcode',
  'price',
  'cost',
  'tax_category_code',
  'product_type',
  'reorder_point',
  'min_stock_level',
  'allow_backorder',
  'status',
] as const;

export type ProductCsvColumn = (typeof PRODUCT_CSV_COLUMNS)[number];

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export const PRODUCT_CSV_TEMPLATE = [
  PRODUCT_CSV_COLUMNS.join(','),
  'MUG-001,Coffee mug,"Ceramic, 350 ml",KITCHEN,Acme,5012345678900,9.99,3.20,STANDARD,simple,10,5,false,active',
  'TEE-001,T-shirt,,CLOTHING,Acme,,,,,variable,,,,active',
].join('\r\n');

export interface ProductCsvRow {
  sku: string;
  name?: string;
  description?: string;
  categoryCode?: string;
  brand?: string;
  barcode?: string;
  price?: number;
  cost?: number;
  taxCategoryCode?: string;
  productType?: ProductType;
  reorderPoint?: number;
  minStockLevel?: number;
  status?: ProductStatus;
}

export interface ParsedCsvRow {
  // 1-based line number in the file (header is line 1)
  line: number;
  data: ProductCsvRow;
  errors: string[];
}

export interface ParsedProductCsv {
  rows: ParsedCsvRow[];
  unknownColumns: string[];
}

export class CsvFormatError extends Error {}

const normalizeHeader = (header: string) =>
  header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');

/**
 * Parse and validate the file's rows on their own (no database lookups).
 * Throws CsvFormatError when the file can't be read as a product CSV.
 */
export function parseProductCsv(input: Buffer | string): ParsedProductCsv {
  let records: string[][];
  try {
    records = parse(input, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true,
    });
  } catch (error) {
    throw new CsvFormatError(
      `Could not read the CSV file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (records.length === 0) {
    throw new CsvFormatError('The file is empty');
  }

  const headers = records[0].map(normalizeHeader);
  if (!headers.includes('sku')) {
    throw new CsvFormatError(
      'The first row must be a header with a "sku" column',
    );
  }
  const duplicates = headers.filter((h, i) => h && headers.indexOf(h) !== i);
  if (duplicates.length) {
    throw new CsvFormatError(
      `Duplicate columns: ${[...new Set(duplicates)].join(', ')}`,
    );
  }
  const known = new Set<string>(PRODUCT_CSV_COLUMNS);
  const unknownColumns = headers.filter((h) => h && !known.has(h));

  const body = records.slice(1);
  if (body.length === 0) {
    throw new CsvFormatError('The file has no product rows');
  }
  if (body.length > MAX_IMPORT_ROWS) {
    throw new CsvFormatError(
      `The file has ${body.length} rows; import at most ${MAX_IMPORT_ROWS} at a time`,
    );
  }

  const rows = body.map((cells, index) => {
    const raw: Partial<Record<ProductCsvColumn, string>> = {};
    headers.forEach((header, i) => {
      if (known.has(header) && cells[i] !== undefined && cells[i] !== '') {
        raw[header as ProductCsvColumn] = cells[i];
      }
    });
    return validateRow(raw, index + 2, cells.length > headers.length);
  });
  return { rows, unknownColumns };
}

function validateRow(
  raw: Partial<Record<ProductCsvColumn, string>>,
  line: number,
  tooManyCells: boolean,
): ParsedCsvRow {
  const errors: string[] = [];
  const data: ProductCsvRow = { sku: raw.sku ?? '' };
  if (tooManyCells) errors.push('More cells than header columns');

  const text = (column: ProductCsvColumn, max: number): string | undefined => {
    const value = raw[column];
    if (value === undefined) return undefined;
    if (value.length > max) {
      errors.push(`${column} is longer than ${max} characters`);
    }
    return value;
  };
  const number = (
    column: ProductCsvColumn,
    { integer = false, money = false } = {},
  ): number | undefined => {
    const value = raw[column];
    if (value === undefined) return undefined;
    const pattern = integer ? /^\d+$/ : /^\d+(\.\d+)?$/;
    if (!pattern.test(value)) {
      errors.push(
        `${column} must be ${integer ? 'a whole number' : 'a positive number'} (got "${value}")`,
      );
      return undefined;
    }
    const parsed = Number(value);
    if (money && parsed > 1e12) errors.push(`${column} is too large`);
    if (integer && parsed > 2_000_000_000)
      errors.push(`${column} is too large`);
    return money ? Math.round(parsed * 100) / 100 : parsed;
  };
  const oneOf = <T extends string>(
    column: ProductCsvColumn,
    allowed: readonly T[],
  ): T | undefined => {
    const value = raw[column]?.toLowerCase();
    if (value === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(value)) {
      errors.push(
        `${column} must be one of ${allowed.join(', ')} (got "${raw[column]}")`,
      );
      return undefined;
    }
    return value as T;
  };

  if (!data.sku) {
    errors.push('sku is required');
  } else if (data.sku.length > 100) {
    errors.push('sku is longer than 100 characters');
  }
  data.name = text('name', 255);
  data.description = text('description', 5000);
  data.categoryCode = text('category_code', 50);
  data.brand = text('brand', 50);
  data.barcode = normalizeBarcode(text('barcode', 100)) ?? undefined;
  data.taxCategoryCode = text('tax_category_code', 50);
  data.price = number('price', { money: true });
  data.cost = number('cost', { money: true });
  data.reorderPoint = number('reorder_point', { integer: true });
  data.minStockLevel = number('min_stock_level', { integer: true });
  data.productType = oneOf('product_type', Object.values(ProductType));
  data.status = oneOf('status', Object.values(ProductStatus));

  // allow_backorder is still an accepted column (older files and exports) but
  // its value is ignored: negative stock is never allowed (D018)

  // Drop unset keys so "undefined" means "leave unchanged"
  for (const key of Object.keys(data) as (keyof ProductCsvRow)[]) {
    if (data[key] === undefined) delete data[key];
  }
  return { line, data, errors };
}
