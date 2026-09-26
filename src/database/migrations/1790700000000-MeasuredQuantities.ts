import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Measured quantities (spec §5 "unit-based and measured quantities", §7 units,
 * Phase 2 weighted barcodes):
 *
 * - Every stock and sale quantity becomes an exact decimal, numeric(19,4), so items
 *   sold by weight, length or volume (units with allowsDecimals, precision 1–4) can
 *   be sold, returned, stocked, counted, transferred and purchased as 1.250 kg.
 *   Existing whole-number values are kept as they are (3 → 3.0000); defaults stay 0.
 *   Whether a quantity may have decimals is decided per item by its unit (API).
 * - product_variants."pluCode": the PLU / scale item code printed inside weighted
 *   and price-embedded EAN-13 barcodes (GS1 prefixes 20–29), unique per store.
 *
 * The weighted barcode settings (prefixes, layout, item code length, value
 * decimals) live in tenants.settings (JSON): no column needed.
 *
 * Down: refused while any quantity has decimals (it would silently change stock).
 */

// table → [column, has DEFAULT 0]
const QUANTITY_COLUMNS: Record<string, [string, boolean][]> = {
  sale_items: [['quantity', false]],
  sale_return_items: [['quantity', false]],
  estimate_items: [['quantity', false]],
  stock_movements: [['quantity', false]],
  stock_levels: [
    ['quantityOnHand', true],
    ['quantityReserved', true],
    ['quantityAvailable', true],
    ['quantityInTransit', true],
  ],
  stock_reservations: [['quantity', false]],
  stock_cost_layers: [
    ['quantityReceived', false],
    ['quantityRemaining', false],
  ],
  stock_transfer_items: [
    ['quantityRequested', false],
    ['quantityDispatched', true],
    ['quantityReceived', true],
    ['quantityWrittenOff', true],
    ['quantityDamaged', true],
    ['quantityMissing', true],
    ['quantityReturned', true],
    ['quantityOverReceived', true],
  ],
  stock_count_items: [
    ['expectedQuantity', false],
    ['countedQuantity', false],
    ['movementsSinceSnapshot', false],
    ['variance', false],
  ],
  goods_receipt_items: [
    ['quantity', false],
    ['quantityReturned', true],
  ],
  purchase_order_items: [
    ['quantityOrdered', false],
    ['quantityReceived', true],
    ['quantityCancelled', true],
  ],
  supplier_return_items: [['quantity', false]],
  supplier_invoice_items: [
    ['quantity', false],
    ['matchableQuantity', false],
    ['quantityVariance', true],
  ],
  product_variants: [
    ['stockQuantity', true],
    ['reservedQuantity', false],
  ],
};

export class MeasuredQuantities1790700000000 implements MigrationInterface {
  name = 'MeasuredQuantities1790700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [table, columns] of Object.entries(QUANTITY_COLUMNS)) {
      const changes = columns.flatMap(([column, hasDefault]) => [
        `ALTER COLUMN "${column}" TYPE numeric(19,4) USING "${column}"::numeric(19,4)`,
        ...(hasDefault ? [`ALTER COLUMN "${column}" SET DEFAULT 0`] : []),
      ]);
      await queryRunner.query(`ALTER TABLE "${table}" ${changes.join(', ')}`);
    }

    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD "pluCode" character varying(6)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_variant_plu" ON "product_variants" ("tenantId", "pluCode") WHERE "pluCode" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [table, columns] of Object.entries(QUANTITY_COLUMNS)) {
      for (const [column] of columns) {
        const rows = (await queryRunner.query(
          `SELECT 1 FROM "${table}" WHERE "${column}" <> TRUNC("${column}") LIMIT 1`,
        )) as unknown[];
        if (rows.length > 0) {
          throw new Error(
            `${table}.${column} holds decimal quantities (measured items): they cannot go back to whole numbers`,
          );
        }
      }
    }

    await queryRunner.query(`DROP INDEX IF EXISTS "uq_variant_plu"`);
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP COLUMN "pluCode"`,
    );

    for (const [table, columns] of Object.entries(QUANTITY_COLUMNS)) {
      const changes = columns.flatMap(([column, hasDefault]) => [
        `ALTER COLUMN "${column}" TYPE integer USING "${column}"::integer`,
        ...(hasDefault ? [`ALTER COLUMN "${column}" SET DEFAULT 0`] : []),
      ]);
      await queryRunner.query(`ALTER TABLE "${table}" ${changes.join(', ')}`);
    }
  }
}
