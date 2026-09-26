import * as ExcelJS from 'exceljs';
import { csvCell as reportCsvCell } from '../reports/report-files';
import { PRODUCT_CSV_COLUMNS, ProductCsvColumn } from './product-csv';

/**
 * Product export in the import template's format (same columns, same order),
 * so an exported file can be edited and imported back. The cost column is
 * left out for people who may not see costs.
 */
export interface ExportProduct {
  sku: string;
  name: Record<string, string> | null;
  description: Record<string, string> | null;
  categoryCode: string | null;
  brand: string | null;
  barcode: string | null;
  price: number | string | null;
  cost: number | string | null;
  taxCategoryCode: string | null;
  productType: string;
  reorderPoint: number | null;
  minStockLevel: number | null;
  allowBackorder: boolean;
  status: string;
}

export function exportColumns(includeCost: boolean): ProductCsvColumn[] {
  return PRODUCT_CSV_COLUMNS.filter((c) => includeCost || c !== 'cost');
}

const money = (value: number | string | null) =>
  value === null || value === undefined || value === ''
    ? ''
    : Number(value).toFixed(2);

export function exportRow(
  product: ExportProduct,
): Record<ProductCsvColumn, string> {
  return {
    sku: product.sku,
    name: product.name?.en ?? Object.values(product.name ?? {})[0] ?? '',
    description: product.description?.en ?? '',
    category_code: product.categoryCode ?? '',
    brand: product.brand ?? '',
    barcode: product.barcode ?? '',
    price: money(product.price),
    cost: money(product.cost),
    tax_category_code: product.taxCategoryCode ?? '',
    product_type: product.productType,
    reorder_point:
      product.reorderPoint === null ? '' : String(product.reorderPoint),
    min_stock_level:
      product.minStockLevel === null ? '' : String(product.minStockLevel),
    allow_backorder: product.allowBackorder ? 'true' : 'false',
    status: product.status,
  };
}

/**
 * Shared report CSV cell (quotes, and neutralises spreadsheet formula injection:
 * a text cell starting with = + - @ tab or CR gets a leading apostrophe), plus
 * quoting of leading/trailing spaces so they survive a re-import.
 */
const csvCell = (value: string) => {
  const cell = reportCsvCell(value);
  return cell === value && /^\s|\s$/.test(value)
    ? `"${value.replace(/"/g, '""')}"`
    : cell;
};

export function toCsv(
  products: ExportProduct[],
  options: { includeCost: boolean },
): Buffer {
  const columns = exportColumns(options.includeCost);
  const lines = [columns.join(',')];
  for (const product of products) {
    const row = exportRow(product);
    lines.push(columns.map((c) => csvCell(row[c])).join(','));
  }
  // BOM so Excel opens UTF-8 (accents in product names) correctly
  return Buffer.from('﻿' + lines.join('\r\n'), 'utf8');
}

export async function toXlsx(
  products: ExportProduct[],
  options: { includeCost: boolean },
): Promise<Buffer> {
  const columns = exportColumns(options.includeCost);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Products');
  sheet.columns = columns.map((key) => ({
    header: key,
    key,
    width: Math.max(12, key.length + 4),
  }));
  sheet.getRow(1).font = { bold: true };
  for (const product of products) {
    const row = exportRow(product);
    // Text cells: SKUs and barcodes keep their leading zeros
    sheet.addRow(Object.fromEntries(columns.map((c) => [c, row[c]])));
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
