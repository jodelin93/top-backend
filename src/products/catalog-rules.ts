/**
 * Catalog rules: tags, barcodes, units, branch assortment, labels. Pure
 * functions, unit tested in catalog-rules.spec.ts.
 */

// ---- Tags ----

export const MAX_TAGS = 30;
export const MAX_TAG_LENGTH = 50;

/**
 * Tags are trimmed, inner spaces collapsed, lower-cased, de-duplicated and
 * capped (MAX_TAGS of at most MAX_TAG_LENGTH characters). Blank tags are dropped.
 */
export function normalizeTags(tags: readonly string[] | null | undefined) {
  const result: string[] = [];
  for (const raw of tags ?? []) {
    const tag = String(raw)
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .slice(0, MAX_TAG_LENGTH);
    if (tag && !result.includes(tag)) result.push(tag);
    if (result.length === MAX_TAGS) break;
  }
  return result;
}

/** "a, b" or ["a", "b"] (query strings) → normalized tags */
export function parseTagFilter(value: string | string[] | undefined) {
  if (value === undefined) return [];
  const parts = Array.isArray(value) ? value : value.split(',');
  return normalizeTags(parts);
}

// ---- Barcodes ----

/**
 * Barcode normalization, applied wherever a barcode is saved or looked up:
 * 1. trim, and remove every space inside ("501 2345 678900" → "5012345678900");
 * 2. purely numeric codes are kept as they are, leading zeros included
 *    (UPC-A "036000291452" stays 12 digits, never parsed as a number);
 * 3. codes with letters are upper-cased (Code 128 / Code 39 in-store labels:
 *    "abc-12" → "ABC-12"), so a scan matches whatever case was typed.
 * Empty → null.
 */
export function normalizeBarcode(value: string | null | undefined) {
  if (value === null || value === undefined) return null;
  const compact = String(value).replace(/\s+/g, '');
  if (!compact) return null;
  return /^\d+$/.test(compact) ? compact : compact.toUpperCase();
}

export type BarcodeFormat = 'ean8' | 'upca' | 'ean13' | 'gtin14' | 'other';

export interface BarcodeCheck {
  barcode: string | null;
  format: BarcodeFormat;
  // Null when the format has no check digit (other)
  checkDigitValid: boolean | null;
  // Shown to the user; the barcode is still accepted
  warning: string | null;
}

/** GS1 mod-10 check digit of the digits before it */
export function gs1CheckDigit(body: string): number {
  let sum = 0;
  // Weights 3,1,3,1… from the rightmost digit of the body
  for (let i = 0; i < body.length; i++) {
    const digit = Number(body[body.length - 1 - i]);
    sum += digit * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10;
}

const GS1_LENGTHS: Record<number, BarcodeFormat> = {
  8: 'ean8',
  12: 'upca',
  13: 'ean13',
  14: 'gtin14',
};

/**
 * Normalize and check a barcode. EAN-8, UPC-A, EAN-13 and GTIN-14 have a
 * check digit: a wrong one is a warning (usually a typo), not an error, since
 * stores also print their own numeric codes.
 */
export function checkBarcode(value: string | null | undefined): BarcodeCheck {
  const barcode = normalizeBarcode(value);
  if (!barcode) {
    return { barcode, format: 'other', checkDigitValid: null, warning: null };
  }
  const format = /^\d+$/.test(barcode)
    ? (GS1_LENGTHS[barcode.length] ?? 'other')
    : 'other';
  if (format === 'other') {
    return { barcode, format, checkDigitValid: null, warning: null };
  }
  const valid =
    gs1CheckDigit(barcode.slice(0, -1)) === Number(barcode.slice(-1));
  return {
    barcode,
    format,
    checkDigitValid: valid,
    warning: valid
      ? null
      : `The check digit of this ${format.toUpperCase()} barcode is wrong: check it for a typo`,
  };
}

// ---- Units ----

export const MAX_UNIT_PRECISION = 4;

/** A unit without decimals has precision 0; with decimals 1–4 (default 3) */
export function unitPrecision(
  allowsDecimals: boolean,
  precision: number | null | undefined,
): number {
  if (!allowsDecimals) return 0;
  const value = Math.round(Number(precision ?? 3));
  return Math.min(MAX_UNIT_PRECISION, Math.max(1, value));
}

export const normalizeUnitCode = (code: string) =>
  code.trim().replace(/\s+/g, '').toLowerCase();

// ---- Branch assortment ----

/**
 * SQL condition "the product (alias) is sold at :branchId": products without
 * any assortment row are sold everywhere. For catalog queries (POS catalog,
 * sync) filtered by the register's branch.
 */
export const soldAtBranchSql = (productAlias = 'product', param = 'branchId') =>
  `(NOT EXISTS (SELECT 1 FROM product_branches pb_all WHERE pb_all."productId" = ${productAlias}.id)
    OR EXISTS (SELECT 1 FROM product_branches pb_here WHERE pb_here."productId" = ${productAlias}.id AND pb_here."branchId" = :${param}))`;

/** Same rule in memory */
export const isSoldAtBranch = (
  assortment: readonly string[] | null | undefined,
  branchId: string | null | undefined,
) => !assortment?.length || !branchId || assortment.includes(branchId);

// ---- Labels ----

export const MAX_LABELS = 1000;
export const MAX_LABEL_COPIES = 500;

export interface LabelSource {
  variantId: string;
  sku: string;
  barcode: string | null;
  productName: Record<string, string> | null;
  variantName: Record<string, string> | null;
  price: number | null;
}

export interface Label {
  variantId: string;
  name: string;
  variantName: string | null;
  sku: string;
  // What the barcode encodes: the variant's barcode, else its SKU
  code: string;
  price: number;
}

const localized = (
  value: Record<string, string> | null | undefined,
  language: string,
) => value?.[language] || value?.en || Object.values(value ?? {})[0] || null;

/**
 * One label per copy, in the order asked. Never carries costs: only name,
 * SKU, code and selling price.
 */
export function buildLabels(
  sources: LabelSource[],
  requests: { variantId: string; copies: number }[],
  language = 'en',
): Label[] {
  const byId = new Map(sources.map((s) => [s.variantId, s]));
  const labels: Label[] = [];
  for (const request of requests) {
    const source = byId.get(request.variantId);
    if (!source) continue;
    const copies = Math.min(
      MAX_LABEL_COPIES,
      Math.max(0, Math.floor(request.copies)),
    );
    const label: Label = {
      variantId: source.variantId,
      name: localized(source.productName, language) ?? source.sku,
      variantName: localized(source.variantName, language),
      sku: source.sku,
      code: source.barcode || source.sku,
      price: Number(source.price ?? 0),
    };
    for (let i = 0; i < copies && labels.length < MAX_LABELS; i++) {
      labels.push({ ...label });
    }
  }
  return labels;
}
