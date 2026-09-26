import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { branchLocationIdsSql, scopedBranchIds } from '../auth/branch-scope';
import { Supplier } from '../database/entities/supplier.entity';
import { SupplierProduct } from '../database/entities/supplier-product.entity';
import { variantDisplayName } from './purchase-orders.service';
import { suggestedReorderQuantity } from './reorder.logic';
import { lineAmount, sumMoney } from './money';
import { ReorderQueryDto } from './purchasing.dto';

interface StockRow {
  variantId: string;
  sku: string;
  variantName: Record<string, string> | null;
  productName: Record<string, string> | null;
  reorderPoint: number | null;
  reorderQuantity: number | null;
  maxStockLevel: number | null;
  cost: number | null;
  onHand: number | string;
  onOrder: number | string;
}

export interface ReorderLine {
  variantId: string;
  sku: string;
  productName: string;
  onHand: number;
  onOrder: number;
  reorderPoint: number;
  reorderQuantity: number | null;
  maxStockLevel: number | null;
  suggestedQuantity: number;
  unitCost: number | null;
  supplierSku: string | null;
  minOrderQty: number | null;
}

export interface ReorderGroup {
  supplier: {
    id: string;
    code: string;
    name: string;
    currencyCode: string | null;
    leadTimeDays: number | null;
  } | null;
  lines: ReorderLine[];
  estimatedTotal: number;
}

// Orders whose outstanding units are already coming
const OPEN_ORDER_STATUSES = [
  'pending_approval',
  'approved',
  'issued',
  'partially_received',
];

/**
 * Reorder suggestions: variants whose stock position (on hand + on order) is at
 * or below the product's reorder point, grouped by preferred supplier, with the
 * quantity to order.
 */
@Injectable()
export class ReorderService {
  constructor(private dataSource: DataSource) {}

  async suggestions(tenantId: string, query: ReorderQueryDto) {
    const locationId = query.locationId ?? null;
    // Branch-limited users: their branches' locations only (spec §9)
    const branches = scopedBranchIds();
    const inScope = (column: string) =>
      `($4::uuid[] IS NULL OR ${column} IN ${branchLocationIdsSql('$4', '$1')})`;
    const rows = await this.dataSource.query<StockRow[]>(
      `SELECT v.id AS "variantId", v.sku, v.name AS "variantName", p.name AS "productName",
              p."reorderPoint", p."reorderQuantity",
              COALESCE(v."maxStockLevel", p."maxStockLevel") AS "maxStockLevel",
              v.cost,
              COALESCE((
                SELECT SUM(sl."quantityOnHand") FROM stock_levels sl
                WHERE sl."tenantId" = v."tenantId" AND sl."variantId" = v.id
                  AND ($2::uuid IS NULL OR sl."locationId" = $2::uuid)
                  AND ${inScope('sl."locationId"')}
              ), 0) AS "onHand",
              COALESCE((
                SELECT SUM(GREATEST(0, poi."quantityOrdered" - poi."quantityCancelled" - poi."quantityReceived"))
                FROM purchase_order_items poi
                JOIN purchase_orders po ON po.id = poi."purchaseOrderId" AND po."tenantId" = poi."tenantId"
                WHERE poi."tenantId" = v."tenantId" AND poi."variantId" = v.id
                  AND po.status::text = ANY($3)
                  AND ($2::uuid IS NULL OR po."locationId" = $2::uuid)
                  AND ${inScope('po."locationId"')}
              ), 0) AS "onOrder"
       FROM product_variants v
       JOIN products p ON p.id = v."productId" AND p."tenantId" = v."tenantId"
       WHERE v."tenantId" = $1
         AND v.status = 'active' AND p.status = 'active'
         AND p."reorderPoint" IS NOT NULL
       ORDER BY v.sku
       LIMIT 5000`,
      [tenantId, locationId, OPEN_ORDER_STATUSES, branches],
    );

    const variantIds = rows.map((r) => r.variantId);
    const supplierProducts = variantIds.length
      ? await this.dataSource.getRepository(SupplierProduct).find({
          where: { tenantId, variantId: In(variantIds) },
        })
      : [];
    // Preferred supplier, else the cheapest known, else any
    const bestFor = new Map<string, SupplierProduct>();
    for (const sp of supplierProducts) {
      const current = bestFor.get(sp.variantId);
      const better =
        !current ||
        (sp.isPreferred && !current.isPreferred) ||
        (sp.isPreferred === current.isPreferred &&
          sp.lastCost != null &&
          (current.lastCost == null ||
            Number(sp.lastCost) < Number(current.lastCost)));
      if (better) bestFor.set(sp.variantId, sp);
    }

    const groups = new Map<string, ReorderLine[]>();
    for (const row of rows) {
      const sp = bestFor.get(row.variantId);
      const onHand = Number(row.onHand);
      const onOrder = Number(row.onOrder);
      const quantity = suggestedReorderQuantity({
        onHand,
        onOrder,
        reorderPoint: row.reorderPoint,
        reorderQuantity: row.reorderQuantity,
        maxStockLevel: row.maxStockLevel,
        minOrderQty: sp?.minOrderQty,
      });
      if (quantity === null) continue;
      const supplierKey = sp?.supplierId ?? '';
      if (query.supplierId && supplierKey !== query.supplierId) continue;
      const lines = groups.get(supplierKey) ?? [];
      lines.push({
        variantId: row.variantId,
        sku: row.sku,
        productName: variantDisplayName(row.productName, row.variantName),
        onHand,
        onOrder,
        reorderPoint: row.reorderPoint!,
        reorderQuantity: row.reorderQuantity,
        maxStockLevel: row.maxStockLevel,
        suggestedQuantity: quantity,
        unitCost:
          sp?.lastCost != null
            ? Number(sp.lastCost)
            : row.cost != null
              ? Number(row.cost)
              : null,
        supplierSku: sp?.supplierSku ?? null,
        minOrderQty: sp?.minOrderQty ?? null,
      });
      groups.set(supplierKey, lines);
    }

    const supplierIds = [...groups.keys()].filter(Boolean);
    const suppliers = supplierIds.length
      ? await this.dataSource.getRepository(Supplier).find({
          where: { tenantId, id: In(supplierIds) },
        })
      : [];
    const byId = new Map(suppliers.map((s) => [s.id, s]));
    const result: ReorderGroup[] = [...groups.entries()].map(([key, lines]) => {
      const supplier = key ? byId.get(key) : undefined;
      return {
        supplier: supplier
          ? {
              id: supplier.id,
              code: supplier.code,
              name: supplier.name,
              currencyCode: supplier.currencyCode,
              leadTimeDays: supplier.leadTimeDays,
            }
          : null,
        lines,
        estimatedTotal: sumMoney(
          lines.map((l) => lineAmount(l.suggestedQuantity, l.unitCost ?? 0)),
        ),
      };
    });
    // Suppliers by name; variants without a supplier last
    result.sort((a, b) =>
      !a.supplier
        ? 1
        : !b.supplier
          ? -1
          : a.supplier.name.localeCompare(b.supplier.name),
    );
    return { locationId, groups: result };
  }
}
