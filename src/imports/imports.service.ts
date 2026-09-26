import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import {
  Product,
  ProductStatus,
  ProductType,
} from '../database/entities/product.entity';
import {
  ProductVariant,
  VariantStatus,
} from '../database/entities/product-variant.entity';
import { Category } from '../database/entities/category.entity';
import { TaxCategory } from '../database/entities/tax-category.entity';
import { ProductBarcode } from '../database/entities/product-barcode.entity';
import { AuditService } from '../audit/audit.service';
import { ProductBarcodesService } from '../products/product-barcodes.service';
import { CsvFormatError, parseProductCsv, ProductCsvRow } from './product-csv';
import { ExportProduct, toCsv, toXlsx } from './product-export';

export type ImportAction = 'create' | 'update' | 'skip' | 'error';

/**
 * What the import does with products that already exist (matched on SKU).
 * Prices are never overwritten unless updatePrices is explicitly chosen.
 */
export interface ImportPolicy {
  onExisting: 'skip' | 'update';
  updatePrices: boolean;
}

export const DEFAULT_IMPORT_POLICY: ImportPolicy = {
  onExisting: 'update',
  updatePrices: false,
};

/** A price or cost in the file that differs from the existing variant */
export interface ImportPriceChange {
  field: 'price' | 'cost';
  from: number | null;
  to: number;
  // False: the policy keeps the current value
  applied: boolean;
}

export interface ImportRowResult {
  line: number;
  sku: string;
  name: string | null;
  action: ImportAction;
  errors: string[];
  // Fields that would change (updates)
  changes: string[];
  // Price/cost differences on existing products, applied or not
  priceChanges: ImportPriceChange[];
}

export interface ImportSummary {
  create: number;
  update: number;
  skip: number;
  error: number;
}

export interface ImportPreview {
  totalRows: number;
  policy: ImportPolicy;
  summary: ImportSummary;
  unknownColumns: string[];
  rows: ImportRowResult[];
}

export interface ImportResult {
  policy: ImportPolicy;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  batches: number;
  // Set when a batch could not be written (earlier batches stay applied)
  error: string | null;
  rows: ImportRowResult[];
}

interface PlannedRow extends ImportRowResult {
  data: ProductCsvRow;
  categoryId?: string | null;
  taxCategoryId?: string | null;
  existing?: Product;
  defaultVariant?: ProductVariant;
}

export const IMPORT_BATCH_SIZE = 100;

const chunk = <T>(items: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, i) =>
    items.slice(i * size, i * size + size),
  );

const defaultVariantOf = (product: Product) =>
  [...(product.variants ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)[0];

/**
 * CSV product import: a dry run (preview) that validates every row and says
 * whether it would create, update or skip a product, then the same plan applied
 * in batches. Rows are matched on SKU, so importing the same file twice
 * changes nothing the second time.
 */
@Injectable()
export class ImportsService {
  constructor(
    private dataSource: DataSource,
    private barcodes: ProductBarcodesService,
    private auditService: AuditService,
  ) {}

  /**
   * Every product in the import template's format (CSV or Excel). Simple
   * products carry their default variant's barcode, price and cost; the cost
   * column is left out unless `includeCost`.
   */
  async export(
    tenantId: string,
    format: 'csv' | 'xlsx',
    options: { includeCost: boolean },
  ): Promise<{ body: Buffer; contentType: string; filename: string }> {
    const rows = await this.dataSource.query<ExportProduct[]>(
      `SELECT p.sku, p.name, p.description, c.code AS "categoryCode", p.brand,
              CASE WHEN p."productType" = 'simple' THEN COALESCE(v.barcode, p.barcode) END AS barcode,
              CASE WHEN p."productType" = 'simple' THEN v.price END AS price,
              CASE WHEN p."productType" = 'simple' THEN v.cost END AS cost,
              t.code AS "taxCategoryCode", p."productType", p."reorderPoint",
              p."minStockLevel", p."allowBackorder", p.status
         FROM products p
         LEFT JOIN categories c ON c.id = p."categoryId"
         LEFT JOIN tax_categories t ON t.id = p."taxCategoryId"
         LEFT JOIN LATERAL (
           SELECT pv.barcode, pv.price, pv.cost FROM product_variants pv
            WHERE pv."productId" = p.id AND pv."tenantId" = p."tenantId"
            ORDER BY pv."sortOrder" ASC, pv.created_at ASC LIMIT 1
         ) v ON true
        WHERE p."tenantId" = $1
        ORDER BY p.sku ASC`,
      [tenantId],
    );
    const includeCost = options.includeCost;
    const stamp = new Date().toISOString().slice(0, 10);
    const body =
      format === 'xlsx'
        ? await toXlsx(rows, { includeCost })
        : toCsv(rows, { includeCost });
    await this.auditService.record({
      tenantId,
      action: 'products.exported',
      entityType: 'product_import',
      metadata: { format, rows: rows.length, includeCost },
    });
    return {
      body,
      contentType:
        format === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv; charset=utf-8',
      filename: `products-${stamp}.${format}`,
    };
  }

  async preview(
    tenantId: string,
    file: Buffer,
    policy: ImportPolicy = DEFAULT_IMPORT_POLICY,
  ): Promise<ImportPreview> {
    const { rows, unknownColumns } = this.parse(file);
    const planned = await this.plan(tenantId, rows, policy);
    return {
      totalRows: planned.length,
      policy,
      summary: this.summarize(planned),
      unknownColumns,
      rows: planned.map((row) => this.toResult(row)),
    };
  }

  async apply(
    tenantId: string,
    file: Buffer,
    options: {
      skipInvalid?: boolean;
      fileName?: string;
      policy?: ImportPolicy;
    } = {},
  ): Promise<ImportResult> {
    const policy = options.policy ?? DEFAULT_IMPORT_POLICY;
    const { rows } = this.parse(file);
    const planned = await this.plan(tenantId, rows, policy);
    const invalid = planned.filter((r) => r.action === 'error');
    if (invalid.length && !options.skipInvalid) {
      throw new BadRequestException(
        `${invalid.length} row(s) have errors. Fix them, or import with skipInvalid to leave them out.`,
      );
    }

    const work = planned.filter(
      (r) => r.action === 'create' || r.action === 'update',
    );
    const batches = chunk(work, IMPORT_BATCH_SIZE);
    const result: ImportResult = {
      policy,
      created: 0,
      updated: 0,
      skipped: planned.filter((r) => r.action === 'skip').length,
      failed: invalid.length,
      batches: batches.length,
      error: null,
      rows: planned.map((row) => this.toResult(row)),
    };

    if (batches.length === 0) {
      // Nothing to write (e.g. the same file imported again): still audit the run
      await this.auditService.record({
        tenantId,
        action: 'products.imported',
        entityType: 'product_import',
        metadata: {
          fileName: options.fileName ?? null,
          policy,
          batches: 0,
          created: 0,
          updated: 0,
          skipped: result.skipped,
          failed: result.failed,
          totalRows: planned.length,
        },
      });
    }

    for (const [index, batch] of batches.entries()) {
      try {
        await this.dataSource.transaction(async (manager) => {
          for (const row of batch) {
            if (row.action === 'create') {
              await this.createProduct(manager, tenantId, row);
            } else {
              await this.updateProduct(manager, tenantId, row, policy);
            }
          }
          const created = batch.filter((r) => r.action === 'create').length;
          // Every price/cost overwrite is traceable to the import that made it
          const priceChanges = batch.flatMap((r) =>
            r.priceChanges
              .filter((c) => c.applied)
              .map((c) => ({ sku: r.sku, ...c })),
          );
          await this.auditService.record(
            {
              tenantId,
              action: 'products.imported',
              entityType: 'product_import',
              metadata: {
                fileName: options.fileName ?? null,
                policy,
                priceChanges,
                batch: index + 1,
                batches: batches.length,
                created,
                updated: batch.length - created,
                skipped: result.skipped,
                failed: result.failed,
                totalRows: planned.length,
              },
            },
            manager,
          );
        });
        const created = batch.filter((r) => r.action === 'create').length;
        result.created += created;
        result.updated += batch.length - created;
      } catch (error) {
        // Earlier batches stay committed; re-running the file continues from here
        const message = error instanceof Error ? error.message : String(error);
        result.error = `Batch ${index + 1} of ${batches.length} failed: ${message}`;
        const failedLines = new Set(
          batches.slice(index).flatMap((b) => b.map((r) => r.line)),
        );
        result.failed += failedLines.size;
        result.rows = result.rows.map((row) =>
          failedLines.has(row.line)
            ? {
                ...row,
                action: 'error',
                errors: [...row.errors, 'Not imported: ' + message],
              }
            : row,
        );
        break;
      }
    }
    return result;
  }

  private parse(file: Buffer) {
    try {
      return parseProductCsv(file);
    } catch (error) {
      if (error instanceof CsvFormatError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  /** Resolve codes, find existing products and decide each row's action */
  private async plan(
    tenantId: string,
    rows: { line: number; data: ProductCsvRow; errors: string[] }[],
    policy: ImportPolicy,
  ): Promise<PlannedRow[]> {
    const manager = this.dataSource.manager;
    const lower = (value: string) => value.toLowerCase();

    const categories = await manager.find(Category, {
      where: { tenantId },
      select: { id: true, code: true },
    });
    const categoryByCode = new Map(
      categories.map((c) => [lower(c.code), c.id]),
    );
    const taxCategories = await manager.find(TaxCategory, {
      where: { tenantId },
      select: { id: true, code: true },
    });
    const taxByCode = new Map(taxCategories.map((t) => [lower(t.code), t.id]));

    const skus = [...new Set(rows.map((r) => r.data.sku).filter(Boolean))];
    const products = new Map<string, Product>();
    const variantSkus = new Map<string, string>(); // sku -> productId
    for (const part of chunk(skus, 500)) {
      const found = await manager.find(Product, {
        where: { tenantId, sku: In(part) },
        relations: { variants: true },
      });
      found.forEach((p) => products.set(p.sku, p));
      const variants = await manager.find(ProductVariant, {
        where: { tenantId, sku: In(part) },
        select: { id: true, sku: true, productId: true },
      });
      variants.forEach((v) => variantSkus.set(v.sku, v.productId));
    }

    const barcodes = [
      ...new Set(
        rows.map((r) => r.data.barcode).filter((b): b is string => !!b),
      ),
    ];
    const barcodeOwners = new Map<string, { variantId: string; sku: string }>();
    for (const part of chunk(barcodes, 500)) {
      const extra = await manager
        .getRepository(ProductBarcode)
        .createQueryBuilder('pb')
        .innerJoin(ProductVariant, 'v', 'v.id = pb.variantId')
        .select([
          'pb.barcode AS barcode',
          'v.id AS "variantId"',
          'v.sku AS sku',
        ])
        .where('pb.tenantId = :tenantId AND pb.barcode IN (:...part)', {
          tenantId,
          part,
        })
        .getRawMany<{ barcode: string; variantId: string; sku: string }>();
      const primary = await manager.find(ProductVariant, {
        where: { tenantId, barcode: In(part) },
        select: { id: true, sku: true, barcode: true },
      });
      primary.forEach((v) =>
        barcodeOwners.set(v.barcode, { variantId: v.id, sku: v.sku }),
      );
      extra.forEach((r) =>
        barcodeOwners.set(r.barcode, { variantId: r.variantId, sku: r.sku }),
      );
    }

    const seenSkus = new Map<string, number>();
    const seenBarcodes = new Map<string, number>();

    return rows.map((row) => {
      const { data } = row;
      const errors = [...row.errors];
      const planned: PlannedRow = {
        line: row.line,
        sku: data.sku,
        name: data.name ?? null,
        action: 'skip',
        errors,
        changes: [],
        priceChanges: [],
        data,
      };

      if (data.sku) {
        const firstLine = seenSkus.get(data.sku);
        if (firstLine) errors.push(`Duplicate SKU (also on line ${firstLine})`);
        else seenSkus.set(data.sku, row.line);
      }
      if (data.barcode) {
        const firstLine = seenBarcodes.get(data.barcode);
        if (firstLine)
          errors.push(`Duplicate barcode (also on line ${firstLine})`);
        else seenBarcodes.set(data.barcode, row.line);
      }

      if (data.categoryCode !== undefined) {
        planned.categoryId = categoryByCode.get(lower(data.categoryCode));
        if (!planned.categoryId)
          errors.push(`Unknown category code "${data.categoryCode}"`);
      }
      if (data.taxCategoryCode !== undefined) {
        planned.taxCategoryId = taxByCode.get(lower(data.taxCategoryCode));
        if (!planned.taxCategoryId) {
          errors.push(`Unknown tax category code "${data.taxCategoryCode}"`);
        }
      }

      const existing = data.sku ? products.get(data.sku) : undefined;
      planned.existing = existing;
      const type =
        existing?.productType ?? data.productType ?? ProductType.SIMPLE;
      if (
        existing &&
        data.productType &&
        data.productType !== existing.productType
      ) {
        errors.push(
          `product_type can't be changed by import (the product is ${existing.productType})`,
        );
      }
      if (type !== ProductType.SIMPLE) {
        for (const field of ['price', 'cost', 'barcode'] as const) {
          if (data[field] !== undefined) {
            errors.push(
              `${field} can only be imported for simple products; set it on the variants`,
            );
          }
        }
      }

      if (!existing) {
        if (!data.name) errors.push('name is required for a new product');
        const variantOwner = data.sku ? variantSkus.get(data.sku) : undefined;
        if (variantOwner) {
          errors.push(
            'This SKU is already used by a variant of another product',
          );
        }
      } else {
        planned.defaultVariant =
          existing.productType === ProductType.SIMPLE
            ? defaultVariantOf(existing)
            : undefined;
      }

      if (data.barcode && type === ProductType.SIMPLE) {
        const owner = barcodeOwners.get(data.barcode);
        if (owner && owner.variantId !== planned.defaultVariant?.id) {
          errors.push(
            `Barcode ${data.barcode} is already used by ${owner.sku}`,
          );
        }
      }

      if (errors.length) {
        planned.action = 'error';
      } else if (!existing) {
        planned.action = 'create';
      } else {
        planned.priceChanges = this.priceDiff(planned, policy);
        if (policy.onExisting === 'skip') {
          // Existing products are left untouched; price differences still shown
          planned.action = 'skip';
        } else {
          planned.changes = this.diff(planned, policy);
          planned.action = planned.changes.length ? 'update' : 'skip';
        }
      }
      return planned;
    });
  }

  /** Price/cost in the row that differ from the existing default variant */
  private priceDiff(
    row: PlannedRow,
    policy: ImportPolicy,
  ): ImportPriceChange[] {
    if (row.existing?.productType !== ProductType.SIMPLE) return [];
    const variant = row.defaultVariant;
    const applied = policy.onExisting === 'update' && policy.updatePrices;
    const changes: ImportPriceChange[] = [];
    for (const field of ['price', 'cost'] as const) {
      const next = row.data[field];
      if (next === undefined) continue;
      const raw = variant?.[field];
      const current = raw === null || raw === undefined ? null : Number(raw);
      if (current !== next) {
        changes.push({ field, from: current, to: next, applied });
      }
    }
    return changes;
  }

  /** Fields of an existing product the row would change */
  private diff(row: PlannedRow, policy: ImportPolicy): string[] {
    const product = row.existing!;
    const variant = row.defaultVariant;
    const { data } = row;
    const changes: string[] = [];
    const differs = (field: string, current: unknown, next: unknown) => {
      if (next === undefined) return;
      const a = current === null || current === undefined ? null : current;
      if (
        typeof next === 'number' ? Number(a) !== next || a === null : a !== next
      ) {
        changes.push(field);
      }
    };
    differs('name', product.name?.en ?? null, data.name);
    differs('description', product.description?.en ?? null, data.description);
    differs('category', product.categoryId, row.categoryId);
    differs('tax category', product.taxCategoryId, row.taxCategoryId);
    differs('brand', product.brand, data.brand);
    differs('reorder point', product.reorderPoint, data.reorderPoint);
    differs('min stock level', product.minStockLevel, data.minStockLevel);
    differs('status', product.status, data.status);
    if (product.productType === ProductType.SIMPLE) {
      differs('barcode', variant?.barcode ?? product.barcode, data.barcode);
      if (policy.updatePrices) {
        differs('price', variant?.price, data.price);
        differs('cost', variant?.cost, data.cost);
      }
    }
    return changes;
  }

  private async createProduct(
    manager: EntityManager,
    tenantId: string,
    row: PlannedRow,
  ): Promise<void> {
    const { data } = row;
    const product = await manager.save(
      manager.create(Product, {
        tenantId,
        sku: data.sku,
        name: { en: data.name! },
        description: data.description ? { en: data.description } : undefined,
        productType: data.productType ?? ProductType.SIMPLE,
        categoryId: row.categoryId ?? undefined,
        taxCategoryId: row.taxCategoryId ?? null,
        brand: data.brand,
        barcode: data.barcode,
        reorderPoint: data.reorderPoint,
        minStockLevel: data.minStockLevel,
        // D018: negative stock is never allowed (allow_backorder is ignored)
        allowBackorder: false,
        status: data.status ?? ProductStatus.ACTIVE,
      }),
    );
    if (product.productType === ProductType.SIMPLE) {
      await this.saveDefaultVariant(
        manager,
        tenantId,
        product,
        undefined,
        data,
        true,
      );
    }
  }

  private async updateProduct(
    manager: EntityManager,
    tenantId: string,
    row: PlannedRow,
    policy: ImportPolicy,
  ): Promise<void> {
    const product = row.existing!;
    const { data } = row;
    const patch: Partial<Product> = {};
    if (data.name !== undefined)
      patch.name = { ...product.name, en: data.name };
    if (data.description !== undefined) {
      patch.description = { ...product.description, en: data.description };
    }
    if (row.categoryId !== undefined) patch.categoryId = row.categoryId!;
    if (row.taxCategoryId !== undefined)
      patch.taxCategoryId = row.taxCategoryId;
    if (data.brand !== undefined) patch.brand = data.brand;
    if (data.reorderPoint !== undefined) patch.reorderPoint = data.reorderPoint;
    if (data.minStockLevel !== undefined)
      patch.minStockLevel = data.minStockLevel;
    if (data.status !== undefined) patch.status = data.status;
    if (data.barcode !== undefined) patch.barcode = data.barcode;
    if (Object.keys(patch).length) {
      await manager.update(Product, { id: product.id, tenantId }, patch);
    }
    if (product.productType === ProductType.SIMPLE) {
      await this.saveDefaultVariant(
        manager,
        tenantId,
        product,
        row.defaultVariant,
        data,
        policy.updatePrices,
      );
    }
    if (data.status === ProductStatus.DISCONTINUED) {
      await manager.update(
        ProductVariant,
        { productId: product.id, tenantId },
        { status: VariantStatus.DISCONTINUED },
      );
    }
  }

  private async saveDefaultVariant(
    manager: EntityManager,
    tenantId: string,
    product: Product,
    variant: ProductVariant | undefined,
    data: ProductCsvRow,
    // Existing prices are only overwritten when the import opted in
    updatePrices: boolean,
  ): Promise<void> {
    let variantId = variant?.id;
    if (variant) {
      const patch: Partial<ProductVariant> = {};
      if (updatePrices && data.price !== undefined) patch.price = data.price;
      if (updatePrices && data.cost !== undefined) patch.cost = data.cost;
      if (data.barcode !== undefined) patch.barcode = data.barcode;
      if (Object.keys(patch).length) {
        await manager.update(
          ProductVariant,
          { id: variant.id, tenantId },
          patch,
        );
      }
    } else {
      const created = await manager.save(
        manager.create(ProductVariant, {
          tenantId,
          productId: product.id,
          sku: product.sku,
          barcode: data.barcode ?? product.barcode,
          price: data.price ?? 0,
          cost: data.cost,
          status: VariantStatus.ACTIVE,
        }),
      );
      variantId = created.id;
    }
    await this.barcodes.syncPrimary(
      manager,
      tenantId,
      variantId!,
      variant ? data.barcode : (data.barcode ?? product.barcode ?? null),
    );
  }

  private summarize(rows: PlannedRow[]): ImportSummary {
    const summary: ImportSummary = { create: 0, update: 0, skip: 0, error: 0 };
    rows.forEach((row) => summary[row.action]++);
    return summary;
  }

  private toResult(row: PlannedRow): ImportRowResult {
    return {
      line: row.line,
      sku: row.sku,
      name: row.name ?? row.existing?.name?.en ?? null,
      action: row.action,
      errors: row.errors,
      changes: row.changes,
      priceChanges: row.priceChanges,
    };
  }
}
