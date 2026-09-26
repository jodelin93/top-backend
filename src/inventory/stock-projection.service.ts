import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { InventoryLocation } from '../database/entities/inventory-location.entity';
import { AuditService } from '../audit/audit.service';
import { addQty, subQty } from '../common/utils/quantity';
import { assertAllBranches, assertLocationAccess } from '../auth/branch-scope';

// Differences returned to the client (the audit log keeps a shorter sample)
const MAX_REPORTED = 1000;

export interface LevelDifference {
  variantId: string;
  locationId: string;
  sku: string | null;
  productName: Record<string, string> | null;
  locationCode: string | null;
  // stock_levels.quantityOnHand now
  projected: number;
  // Net of every movement in and out of the location
  ledger: number;
  difference: number;
}

export interface VariantDifference {
  variantId: string;
  sku: string;
  productName: Record<string, string> | null;
  // product_variants.stockQuantity now
  current: number;
  // Sum of the (corrected) per-location on-hand quantities
  expected: number;
  difference: number;
}

export interface RebuildReport {
  locationId: string | null;
  applied: boolean;
  levelDifferences: LevelDifference[];
  variantDifferences: VariantDifference[];
  totals: { levels: number; variants: number };
}

// Keep responses small: totals always have the full counts
const trimReport = (report: RebuildReport): RebuildReport => ({
  ...report,
  levelDifferences: report.levelDifferences.slice(0, MAX_REPORTED),
  variantDifferences: report.variantDifferences.slice(0, MAX_REPORTED),
});

/**
 * Stock projection rebuild (R062). The append-only stock_movements ledger is the
 * source of truth; stock_levels.quantityOnHand (per location) and
 * product_variants.stockQuantity (all locations) are projections of it that
 * applyMovement() keeps up to date. This recomputes them from the ledger.
 */
@Injectable()
export class StockProjectionService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {}

  /**
   * Compare the projections with the ledger without changing anything
   */
  async preview(tenantId: string, locationId?: string): Promise<RebuildReport> {
    await this.assertLocation(tenantId, locationId);
    const report = await this.dataSource.transaction(
      'REPEATABLE READ',
      (manager) => this.compute(manager, tenantId, locationId ?? null, false),
    );
    return trimReport(report);
  }

  /**
   * Overwrite the projections with the ledger's numbers (audited)
   */
  async apply(tenantId: string, locationId?: string): Promise<RebuildReport> {
    await this.assertLocation(tenantId, locationId);
    return this.dataSource.transaction(async (manager) => {
      // Stop sales / receipts in scope from changing stock meanwhile
      await manager.query(
        `SELECT id FROM stock_levels
          WHERE "tenantId" = $1 AND ($2::uuid IS NULL OR "locationId" = $2)
          ORDER BY id FOR UPDATE`,
        [tenantId, locationId ?? null],
      );
      const report = await this.compute(
        manager,
        tenantId,
        locationId ?? null,
        true,
      );

      for (const diff of report.levelDifferences) {
        await manager.query(
          `INSERT INTO stock_levels (id, "tenantId", "variantId", "locationId", "quantityOnHand", "quantityAvailable", created_at, updated_at)
           VALUES (uuid_generate_v4(), $1, $2, $3, $4, $4, NOW(), NOW())
           ON CONFLICT ("variantId", "locationId") DO UPDATE
             SET "quantityOnHand" = EXCLUDED."quantityOnHand",
                 "quantityAvailable" = EXCLUDED."quantityOnHand" - stock_levels."quantityReserved",
                 version = stock_levels.version + 1,
                 updated_at = NOW()`,
          [tenantId, diff.variantId, diff.locationId, diff.ledger],
        );
      }
      for (const diff of report.variantDifferences) {
        await manager.query(
          `UPDATE product_variants SET "stockQuantity" = $3, version = version + 1, updated_at = NOW()
            WHERE "tenantId" = $1 AND id = $2`,
          [tenantId, diff.variantId, diff.expected],
        );
      }

      await this.auditService.record(
        {
          tenantId,
          action: 'inventory.projection_rebuilt',
          entityType: 'stock_level',
          entityId: locationId ?? null,
          metadata: {
            locationId: locationId ?? null,
            totals: report.totals,
            levelDifferences: report.levelDifferences
              .slice(0, 100)
              .map(({ variantId, locationId: loc, projected, ledger }) => ({
                variantId,
                locationId: loc,
                before: projected,
                after: ledger,
              })),
            variantDifferences: report.variantDifferences
              .slice(0, 100)
              .map(({ variantId, current, expected }) => ({
                variantId,
                before: current,
                after: expected,
              })),
          },
        },
        manager,
      );
      return trimReport(report);
    });
  }

  private async compute(
    manager: EntityManager,
    tenantId: string,
    locationId: string | null,
    applied: boolean,
  ): Promise<RebuildReport> {
    // Ledger balance per (variant, location) in scope vs the stored level
    const levelRows = await manager.query<
      {
        variantId: string;
        locationId: string;
        ledger: number;
        projected: number;
      }[]
    >(
      `WITH ledger AS (
         SELECT "variantId", "toLocationId" AS "locationId", SUM(quantity) AS q
           FROM stock_movements
          WHERE "tenantId" = $1 AND "toLocationId" IS NOT NULL
            AND ($2::uuid IS NULL OR "toLocationId" = $2)
          GROUP BY 1, 2
         UNION ALL
         SELECT "variantId", "fromLocationId", -SUM(quantity)
           FROM stock_movements
          WHERE "tenantId" = $1 AND "fromLocationId" IS NOT NULL
            AND ($2::uuid IS NULL OR "fromLocationId" = $2)
          GROUP BY 1, 2
       ), sums AS (
         SELECT "variantId", "locationId", SUM(q)::numeric(19,4) AS ledger FROM ledger GROUP BY 1, 2
       ), levels AS (
         SELECT "variantId", "locationId", "quantityOnHand" FROM stock_levels
          WHERE "tenantId" = $1 AND ($2::uuid IS NULL OR "locationId" = $2)
       )
       SELECT COALESCE(s."variantId", l."variantId") AS "variantId",
              COALESCE(s."locationId", l."locationId") AS "locationId",
              COALESCE(s.ledger, 0) AS ledger,
              COALESCE(l."quantityOnHand", 0) AS projected
         FROM sums s
         FULL OUTER JOIN levels l
           ON l."variantId" = s."variantId" AND l."locationId" = s."locationId"
        WHERE COALESCE(s.ledger, 0) <> COALESCE(l."quantityOnHand", 0)`,
      [tenantId, locationId],
    );

    // Variant totals = sum of per-location levels, with the corrections applied
    const corrections = new Map<string, number>();
    for (const row of levelRows) {
      corrections.set(
        row.variantId,
        subQty(
          addQty(corrections.get(row.variantId) ?? 0, Number(row.ledger)),
          Number(row.projected),
        ),
      );
    }
    const variantRows = await manager.query<
      { variantId: string; current: number; levelSum: number }[]
    >(
      `SELECT v.id AS "variantId", v."stockQuantity" AS current,
              COALESCE(SUM(l."quantityOnHand"), 0)::numeric(19,4) AS "levelSum"
         FROM product_variants v
         LEFT JOIN stock_levels l ON l."variantId" = v.id AND l."tenantId" = v."tenantId"
        WHERE v."tenantId" = $1
        GROUP BY v.id`,
      [tenantId],
    );
    const variantDiffs = variantRows
      .map((row) => {
        const expected = addQty(
          Number(row.levelSum),
          corrections.get(row.variantId) ?? 0,
        );
        return {
          variantId: row.variantId,
          current: Number(row.current),
          expected,
          difference: subQty(expected, Number(row.current)),
        };
      })
      .filter((row) => row.difference !== 0);

    // Labels for the report
    const variantIds = [
      ...new Set([
        ...levelRows.map((r) => r.variantId),
        ...variantDiffs.map((r) => r.variantId),
      ]),
    ];
    const labels = variantIds.length
      ? await manager.query<
          { id: string; sku: string; productName: Record<string, string> }[]
        >(
          `SELECT v.id, v.sku, p.name AS "productName"
             FROM product_variants v JOIN products p ON p.id = v."productId"
            WHERE v."tenantId" = $1 AND v.id = ANY($2::uuid[])`,
          [tenantId, variantIds],
        )
      : [];
    const labelOf = new Map(labels.map((l) => [l.id, l]));
    const locations = await manager.find(InventoryLocation, {
      where: { tenantId },
      select: { id: true, code: true },
    });
    const codeOf = new Map(locations.map((l) => [l.id, l.code]));

    return {
      locationId,
      applied,
      totals: { levels: levelRows.length, variants: variantDiffs.length },
      levelDifferences: levelRows.map((row) => ({
        variantId: row.variantId,
        locationId: row.locationId,
        sku: labelOf.get(row.variantId)?.sku ?? null,
        productName: labelOf.get(row.variantId)?.productName ?? null,
        locationCode: codeOf.get(row.locationId) ?? null,
        projected: Number(row.projected),
        ledger: Number(row.ledger),
        difference: subQty(Number(row.ledger), Number(row.projected)),
      })),
      variantDifferences: variantDiffs.map((row) => ({
        ...row,
        sku: labelOf.get(row.variantId)?.sku ?? '',
        productName: labelOf.get(row.variantId)?.productName ?? null,
      })),
    };
  }

  private async assertLocation(tenantId: string, locationId?: string) {
    // The whole store: only for users with every branch (spec §9)
    if (!locationId) {
      assertAllBranches(
        null,
        'Choose a location: rebuilding every location needs access to every branch',
      );
      return;
    }
    const exists = await this.dataSource
      .getRepository(InventoryLocation)
      .exists({ where: { tenantId, id: locationId } });
    if (!exists) throw new NotFoundException('Location not found');
    await assertLocationAccess(this.dataSource.manager, tenantId, locationId);
  }
}
