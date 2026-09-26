import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Offline sync v2 (spec §19):
 *
 * - sync_change_log: per-store change log written by triggers on the catalog,
 *   prices, stock, customers and POS context tables. Each row has a monotonic
 *   seq and the writing transaction's id (txid, xid8), which the opaque sync
 *   cursor uses as a consistent snapshot boundary. Deletions are logged too
 *   (op 'D'): the till receives them as tombstones. No foreign key to tenants on
 *   purpose: removing a store cascades deletes that are themselves logged.
 * - sync_operations: per-operation acknowledgement of POST /sync/push (keyed by
 *   the device's operation id), lease id and limits bookkeeping.
 * - devices: lease issue time and sync queue details for the sync dashboard.
 */

// table, entity, id column, tenant column, scope column
const LOGGED: [string, string, string, string, string | null][] = [
  ['products', 'product', 'id', 'tenantId', null],
  ['product_branches', 'product', 'productId', 'tenantId', null],
  ['product_variants', 'variant', 'id', 'tenantId', null],
  ['product_barcodes', 'variant', 'variantId', 'tenantId', null],
  ['price_entries', 'variant', 'variantId', 'tenantId', null],
  ['price_lists', 'price_list', 'id', 'tenantId', null],
  ['stock_levels', 'stock', 'variantId', 'tenantId', 'locationId'],
  ['customers', 'customer', 'id', 'tenantId', null],
  ['categories', 'category', 'id', 'tenantId', null],
  ['tax_rates', 'tax', 'id', 'tenantId', null],
  ['tax_categories', 'tax', 'id', 'tenantId', null],
  ['payment_methods', 'payment_method', 'id', 'tenantId', null],
  ['registers', 'register', 'id', 'tenantId', null],
  ['branches', 'branch', 'id', 'tenantId', null],
];

const trigger = (table: string) => `trg_${table}_sync_log`;

export class OfflineSyncV21790520000000 implements MigrationInterface {
  name = 'OfflineSyncV21790520000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- Change log ----
    await queryRunner.query(`
      CREATE TABLE "sync_change_log" (
        "seq" bigserial NOT NULL,
        "tenantId" uuid NOT NULL,
        "entity" character varying(30) NOT NULL,
        "entityId" uuid NOT NULL,
        "op" character(1) NOT NULL,
        "scope" uuid,
        "txid" xid8 NOT NULL DEFAULT pg_current_xact_id(),
        "changed_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sync_change_log" PRIMARY KEY ("seq"),
        CONSTRAINT "CHK_sync_change_log_op" CHECK ("op" IN ('U', 'D'))
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_sync_change_log_tenant_seq" ON "sync_change_log" ("tenantId", "seq")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sync_change_log_tenant_txid" ON "sync_change_log" ("tenantId", "txid")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sync_change_log_changed_at" ON "sync_change_log" ("changed_at")`,
    );

    // Generic row trigger: TG_ARGV = entity, id column, tenant column, scope column
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION sync_log_change() RETURNS trigger AS $$
      DECLARE
        rec jsonb;
      BEGIN
        IF TG_OP = 'DELETE' THEN
          rec := to_jsonb(OLD);
        ELSE
          rec := to_jsonb(NEW);
        END IF;
        IF rec ->> TG_ARGV[2] IS NULL OR rec ->> TG_ARGV[1] IS NULL THEN
          RETURN NULL;
        END IF;
        INSERT INTO sync_change_log ("tenantId", entity, "entityId", op, scope)
        VALUES (
          (rec ->> TG_ARGV[2])::uuid,
          TG_ARGV[0],
          (rec ->> TG_ARGV[1])::uuid,
          CASE WHEN TG_OP = 'DELETE' THEN 'D' ELSE 'U' END,
          CASE WHEN TG_ARGV[3] = '' THEN NULL ELSE (rec ->> TG_ARGV[3])::uuid END
        );
        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql`);
    for (const [table, entity, idCol, tenantCol, scopeCol] of LOGGED) {
      await queryRunner.query(
        `CREATE TRIGGER "${trigger(table)}" AFTER INSERT OR UPDATE OR DELETE ON "${table}"
         FOR EACH ROW EXECUTE FUNCTION sync_log_change('${entity}', '${idCol}', '${tenantCol}', '${scopeCol ?? ''}')`,
      );
    }
    // Store settings live on the tenant row (updates only: a store being removed
    // must not log)
    await queryRunner.query(
      `CREATE TRIGGER "${trigger('tenants')}" AFTER UPDATE ON "tenants"
       FOR EACH ROW EXECUTE FUNCTION sync_log_change('settings', 'id', 'id', '')`,
    );

    // ---- Push acknowledgements ----
    await queryRunner.query(`
      CREATE TABLE "sync_operations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "deviceId" uuid,
        "deviceOperationId" character varying(100) NOT NULL,
        "deviceSequence" integer,
        "opType" character varying(30) NOT NULL,
        "schemaVersion" integer NOT NULL DEFAULT 1,
        "payloadHash" character varying(64) NOT NULL,
        "status" character varying(20) NOT NULL,
        "saleId" uuid,
        "reason" character varying(500),
        "leaseId" uuid,
        "leaseIssues" jsonb NOT NULL DEFAULT '[]',
        "amount" numeric(19,4) NOT NULL DEFAULT 0,
        "capturedAt" TIMESTAMP WITH TIME ZONE,
        "actorId" uuid,
        "snapshot" jsonb,
        "importedBy" uuid,
        "attempts" integer NOT NULL DEFAULT 1,
        "lastAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PK_sync_operations" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_sync_operations_status" CHECK ("status" IN ('accepted', 'needs_review')),
        CONSTRAINT "FK_sync_operations_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sync_operations_op" ON "sync_operations" ("tenantId", "deviceOperationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sync_operations_device" ON "sync_operations" ("tenantId", "deviceId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sync_operations_lease" ON "sync_operations" ("tenantId", "leaseId", "deviceSequence") WHERE "leaseId" IS NOT NULL`,
    );

    // ---- Devices: lease and queue details ----
    await queryRunner.query(`ALTER TABLE "devices"
      ADD "leaseIssuedAt" TIMESTAMP WITH TIME ZONE,
      ADD "oldestPendingAt" TIMESTAMP WITH TIME ZONE,
      ADD "pendingAmount" numeric(19,4) NOT NULL DEFAULT 0,
      ADD "syncRetries" integer NOT NULL DEFAULT 0`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_conflict_cases_device" ON "conflict_cases" ("tenantId", "deviceId", "status") WHERE "deviceId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_conflict_cases_device"`);
    await queryRunner.query(`ALTER TABLE "devices"
      DROP COLUMN "syncRetries",
      DROP COLUMN "pendingAmount",
      DROP COLUMN "oldestPendingAt",
      DROP COLUMN "leaseIssuedAt"`);
    await queryRunner.query(`DROP TABLE "sync_operations"`);
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "${trigger('tenants')}" ON "tenants"`,
    );
    for (const [table] of LOGGED) {
      await queryRunner.query(
        `DROP TRIGGER IF EXISTS "${trigger(table)}" ON "${table}"`,
      );
    }
    await queryRunner.query(`DROP FUNCTION IF EXISTS sync_log_change()`);
    await queryRunner.query(`DROP TABLE "sync_change_log"`);
  }
}
