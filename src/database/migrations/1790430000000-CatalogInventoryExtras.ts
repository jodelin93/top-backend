import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Catalog & inventory wave (spec §7–§9):
 *
 * - D018: negative stock is never allowed. products.allowBackorder is set to
 *   false everywhere (column kept for history; no stock decision reads it).
 * - Ledger integrity on stock_movements: sourceEventId (unique per store when
 *   set; historical rows stay NULL), correlationId, reversalOfId, and an
 *   append-only trigger: UPDATE and DELETE are rejected. Escapes, like
 *   audit_logs: DELETE when `SET LOCAL app.audit_purge = 'on'` (whole test
 *   tenant removal, same switch as the audit log) or
 *   `SET LOCAL app.stock_ledger_purge = 'on'`; UPDATE only with
 *   `SET LOCAL app.stock_ledger_maintenance = 'on'` (a reviewed data repair;
 *   nothing in the application updates or deletes movements).
 * - Location stock status (sellable / quarantine / damaged / transit);
 *   isSellable is kept in line with it.
 * - Transfer workflow: requested / approved / partially_dispatched statuses,
 *   transit location, damaged / missing / returned / over-received quantities,
 *   dispatch / receipt events with idempotency keys. Transfers already in
 *   transit keep their counter-only transit (transitLedger = false).
 * - Stock counts: snapshotAt, per-line reason and roll-forward movements.
 * - Catalog: product tags, units of measure, branch assortment, unique variant
 *   option combinations (combinationKey), barcode normalization of stored codes.
 * - Permission inventory.transfer.approve for the built-in owner/admin/manager.
 */
export class CatalogInventoryExtras1790430000000 implements MigrationInterface {
  name = 'CatalogInventoryExtras1790430000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- D018 ----
    await queryRunner.query(
      `UPDATE "products" SET "allowBackorder" = false WHERE "allowBackorder" = true`,
    );

    // ---- Stock movements: identity, correlation, reversal ----
    await queryRunner.query(
      `ALTER TYPE "public"."stock_movements_movementtype_enum" ADD VALUE IF NOT EXISTS 'revaluation'`,
    );
    await queryRunner.query(`ALTER TABLE "stock_movements"
      ADD "sourceEventId" character varying(200),
      ADD "correlationId" character varying(100),
      ADD "reversalOfId" uuid`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_stock_movements_source_event" ON "stock_movements" ("tenantId", "sourceEventId") WHERE "sourceEventId" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "fk_stock_movements_reversal_of" FOREIGN KEY ("reversalOfId") REFERENCES "stock_movements"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    // ---- Location stock status ----
    await queryRunner.query(
      `CREATE TYPE "public"."inventory_locations_stockstatus_enum" AS ENUM('sellable', 'quarantine', 'damaged', 'transit')`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" ADD "stockStatus" "public"."inventory_locations_stockstatus_enum" NOT NULL DEFAULT 'sellable'`,
    );
    await queryRunner.query(`
      UPDATE "inventory_locations" l SET "stockStatus" = 'quarantine', "isSellable" = false
        FROM "warehouses" w
       WHERE w.id = l."warehouseId"
         AND (l."isSellable" = false OR w."warehouseType" = 'quarantine')`);

    // ---- Transfers ----
    for (const value of ['requested', 'approved', 'partially_dispatched']) {
      await queryRunner.query(
        `ALTER TYPE "public"."stock_transfers_status_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.query(`ALTER TABLE "stock_transfers"
      ADD "transitLedger" boolean NOT NULL DEFAULT true,
      ADD "transitLocationId" uuid,
      ADD "approvalRequired" boolean NOT NULL DEFAULT false,
      ADD "requestedById" uuid,
      ADD "requestedAt" TIMESTAMP WITH TIME ZONE,
      ADD "approvedById" uuid,
      ADD "approvedAt" TIMESTAMP WITH TIME ZONE,
      ADD "dispatchComplete" boolean NOT NULL DEFAULT false`);
    // Dispatched before this wave: one dispatch, transit only in the counter
    await queryRunner.query(`
      UPDATE "stock_transfers"
         SET "transitLedger" = ("status" NOT IN ('in_transit', 'partially_received')),
             "dispatchComplete" = ("status" IN ('in_transit', 'partially_received', 'received'))`);
    await queryRunner.query(
      `ALTER TABLE "stock_transfers" ADD CONSTRAINT "fk_stock_transfers_transit_location" FOREIGN KEY ("transitLocationId", "tenantId") REFERENCES "inventory_locations"("id", "tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_transfers" ADD CONSTRAINT "fk_stock_transfers_requested_by" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_transfers" ADD CONSTRAINT "fk_stock_transfers_approved_by" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`ALTER TABLE "stock_transfer_items"
      ADD "quantityDamaged" integer NOT NULL DEFAULT 0,
      ADD "quantityMissing" integer NOT NULL DEFAULT 0,
      ADD "quantityReturned" integer NOT NULL DEFAULT 0,
      ADD "quantityOverReceived" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(`
      CREATE TABLE "stock_transfer_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "transferId" uuid NOT NULL,
        "kind" character varying(20) NOT NULL,
        "idempotencyKey" character varying(100),
        "userId" uuid NOT NULL,
        "approverId" uuid,
        "lines" jsonb NOT NULL DEFAULT '[]',
        "notes" character varying(500),
        CONSTRAINT "PK_stock_transfer_events" PRIMARY KEY ("id"),
        CONSTRAINT "uq_stock_transfer_events_key" UNIQUE ("tenantId", "transferId", "kind", "idempotencyKey"),
        CONSTRAINT "fk_stock_transfer_events_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_stock_transfer_events_transfer" FOREIGN KEY ("transferId", "tenantId") REFERENCES "stock_transfers"("id", "tenantId") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_stock_transfer_events_transfer" ON "stock_transfer_events" ("tenantId", "transferId")`,
    );

    // ---- Stock counts: roll-forward and reasons ----
    await queryRunner.query(
      `ALTER TABLE "stock_counts" ADD "snapshotAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `UPDATE "stock_counts" SET "snapshotAt" = "created_at"`,
    );
    await queryRunner.query(`ALTER TABLE "stock_count_items"
      ADD "movementsSinceSnapshot" integer,
      ADD "reason" character varying(200)`);

    // ---- Units of measure ----
    await queryRunner.query(`
      CREATE TABLE "units" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "code" character varying(20) NOT NULL,
        "name" character varying(100) NOT NULL,
        "allowsDecimals" boolean NOT NULL DEFAULT false,
        "precision" smallint NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        CONSTRAINT "PK_units" PRIMARY KEY ("id"),
        CONSTRAINT "uq_units_code" UNIQUE ("tenantId", "code"),
        CONSTRAINT "uq_units_id_tenant" UNIQUE ("id", "tenantId"),
        CONSTRAINT "chk_units_precision" CHECK ("precision" BETWEEN 0 AND 4),
        CONSTRAINT "fk_units_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_units_tenant" ON "units" ("tenantId")`,
    );

    // ---- Products: tags, unit ----
    await queryRunner.query(`ALTER TABLE "products"
      ADD "tags" text array NOT NULL DEFAULT '{}',
      ADD "unitId" uuid`);
    await queryRunner.query(
      `CREATE INDEX "idx_products_tags" ON "products" USING GIN ("tags")`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "fk_products_unit" FOREIGN KEY ("unitId") REFERENCES "units"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    // ---- Branch assortment ----
    await queryRunner.query(`
      CREATE TABLE "product_branches" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "productId" uuid NOT NULL,
        "branchId" uuid NOT NULL,
        CONSTRAINT "PK_product_branches" PRIMARY KEY ("id"),
        CONSTRAINT "uq_product_branches" UNIQUE ("productId", "branchId"),
        CONSTRAINT "fk_product_branches_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "fk_product_branches_product" FOREIGN KEY ("productId", "tenantId") REFERENCES "products"("id", "tenantId") ON DELETE CASCADE,
        CONSTRAINT "fk_product_branches_branch" FOREIGN KEY ("branchId", "tenantId") REFERENCES "branches"("id", "tenantId") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_product_branches_tenant_branch" ON "product_branches" ("tenantId", "branchId")`,
    );

    // ---- Unique variant option combinations ----
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD "combinationKey" character varying(1000)`,
    );
    // Same format as combinationKey() in variant-generator.ts. Existing
    // duplicates keep a NULL key (the oldest non-discontinued one gets it).
    await queryRunner.query(`
      WITH keys AS (
        SELECT av."variantId",
               string_agg(av."attributeId"::text || '=' || lower(btrim(av.value)), '|'
                          ORDER BY av."attributeId"::text) AS key
          FROM "attribute_values" av
         GROUP BY av."variantId"
      ), ranked AS (
        SELECT v.id, k.key,
               ROW_NUMBER() OVER (
                 PARTITION BY v."tenantId", v."productId", k.key
                 ORDER BY (v.status = 'discontinued'), v.created_at, v.id
               ) AS rn
          FROM "product_variants" v
          JOIN keys k ON k."variantId" = v.id
      )
      UPDATE "product_variants" v SET "combinationKey" = LEFT(r.key, 1000)
        FROM ranked r
       WHERE r.id = v.id AND r.rn = 1`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_variant_combination" ON "product_variants" ("tenantId", "productId", "combinationKey") WHERE "combinationKey" IS NOT NULL`,
    );

    // ---- Barcode normalization (catalog-rules.ts normalizeBarcode) ----
    const normalized = (column: string) =>
      `CASE WHEN regexp_replace(${column}, '\\s', '', 'g') ~ '^[0-9]+$'
            THEN regexp_replace(${column}, '\\s', '', 'g')
            ELSE upper(regexp_replace(${column}, '\\s', '', 'g')) END`;
    await queryRunner.query(`
      UPDATE "products" SET "barcode" = ${normalized('"barcode"')}
       WHERE "barcode" IS NOT NULL AND "barcode" <> ${normalized('"barcode"')}
         AND ${normalized('"barcode"')} <> ''`);
    await queryRunner.query(`
      UPDATE "product_variants" SET "barcode" = ${normalized('"barcode"')}
       WHERE "barcode" IS NOT NULL AND "barcode" <> ${normalized('"barcode"')}
         AND ${normalized('"barcode"')} <> ''`);
    // Unique per store: a code that would collide is left as it was
    await queryRunner.query(`
      WITH candidates AS (
        SELECT pb.id, pb."tenantId", ${normalized('pb.barcode')} AS nb
          FROM "product_barcodes" pb
         WHERE pb.barcode <> ${normalized('pb.barcode')}
      ), ranked AS (
        SELECT c.*, ROW_NUMBER() OVER (PARTITION BY c."tenantId", c.nb ORDER BY c.id) AS rn
          FROM candidates c
         WHERE c.nb <> ''
           AND NOT EXISTS (
             SELECT 1 FROM "product_barcodes" o
              WHERE o."tenantId" = c."tenantId" AND o.barcode = c.nb)
      )
      UPDATE "product_barcodes" pb SET "barcode" = r.nb
        FROM ranked r
       WHERE r.id = pb.id AND r.rn = 1`);

    // ---- Permission ----
    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" || jsonb_build_array($1::text)
       WHERE "isSystem" = true AND "key" IN ('owner', 'admin', 'manager') AND NOT "permissions" ? $1`,
      ['inventory.transfer.approve'],
    );

    // ---- Append-only ledger (last: nothing above touches existing movements) ----
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION stock_movements_append_only() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND (
             current_setting('app.audit_purge', true) = 'on'
          OR current_setting('app.stock_ledger_purge', true) = 'on') THEN
          RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE' AND current_setting('app.stock_ledger_maintenance', true) = 'on' THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'stock_movements is append-only: post a correcting movement instead';
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(`
      CREATE TRIGGER "trg_stock_movements_append_only"
      BEFORE UPDATE OR DELETE ON "stock_movements"
      FOR EACH ROW EXECUTE FUNCTION stock_movements_append_only()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_stock_movements_append_only" ON "stock_movements"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS stock_movements_append_only()`,
    );
    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" - $1::text WHERE "permissions" ? $1`,
      ['inventory.transfer.approve'],
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_variant_combination"`);
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP COLUMN "combinationKey"`,
    );
    await queryRunner.query(`DROP TABLE "product_branches"`);
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT "fk_products_unit"`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "idx_products_tags"`);
    await queryRunner.query(
      `ALTER TABLE "products" DROP COLUMN "unitId", DROP COLUMN "tags"`,
    );
    await queryRunner.query(`DROP TABLE "units"`);
    await queryRunner.query(`ALTER TABLE "stock_count_items"
      DROP COLUMN "reason", DROP COLUMN "movementsSinceSnapshot"`);
    await queryRunner.query(
      `ALTER TABLE "stock_counts" DROP COLUMN "snapshotAt"`,
    );
    await queryRunner.query(`DROP TABLE "stock_transfer_events"`);
    await queryRunner.query(`ALTER TABLE "stock_transfer_items"
      DROP COLUMN "quantityOverReceived", DROP COLUMN "quantityReturned",
      DROP COLUMN "quantityMissing", DROP COLUMN "quantityDamaged"`);
    await queryRunner.query(`ALTER TABLE "stock_transfers"
      DROP CONSTRAINT "fk_stock_transfers_approved_by",
      DROP CONSTRAINT "fk_stock_transfers_requested_by",
      DROP CONSTRAINT "fk_stock_transfers_transit_location"`);
    await queryRunner.query(`ALTER TABLE "stock_transfers"
      DROP COLUMN "dispatchComplete", DROP COLUMN "approvedAt",
      DROP COLUMN "approvedById", DROP COLUMN "requestedAt",
      DROP COLUMN "requestedById", DROP COLUMN "approvalRequired",
      DROP COLUMN "transitLocationId", DROP COLUMN "transitLedger"`);
    // Enum values added to stock_transfers_status_enum and
    // stock_movements_movementtype_enum stay (Postgres cannot drop them)
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" DROP COLUMN "stockStatus"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."inventory_locations_stockstatus_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "fk_stock_movements_reversal_of"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "uq_stock_movements_source_event"`,
    );
    await queryRunner.query(`ALTER TABLE "stock_movements"
      DROP COLUMN "reversalOfId", DROP COLUMN "correlationId", DROP COLUMN "sourceEventId"`);
  }
}
