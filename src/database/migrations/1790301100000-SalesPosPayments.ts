import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sales, POS and payments (R031, R042, R044, R046, R051–R056, R112–R114):
 * - sale lifecycle states (held, payment_pending, cancelled) and held-cart fields
 * - shift link, offline number and device fields, receipt reprint counter
 * - per-line tax rate and original price (price overrides) on sale items
 * - payment providers: provider on payment methods, payment state machine,
 *   webhook event log and card settlement reconciliation tables
 */
export class SalesPosPayments1790301100000 implements MigrationInterface {
  name = 'SalesPosPayments1790301100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- Sale lifecycle ----
    for (const value of ['held', 'payment_pending', 'cancelled']) {
      await queryRunner.query(
        `ALTER TYPE "public"."sales_status_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.query(`
      ALTER TABLE "sales"
        ADD "shiftId" uuid,
        ADD "offlineNumber" character varying(50),
        ADD "deviceId" uuid,
        ADD "deviceSequence" integer,
        ADD "receiptPrintCount" integer NOT NULL DEFAULT 0,
        ADD "heldUntil" TIMESTAMP WITH TIME ZONE,
        ADD "heldLabel" character varying(100)`);
    await queryRunner.query(
      `CREATE INDEX "IDX_sales_tenant_status_register" ON "sales" ("tenantId", "status", "registerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sales_tenant_shift" ON "sales" ("tenantId", "shiftId") WHERE "shiftId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sales_tenant_offline_number" ON "sales" ("tenantId", "offlineNumber") WHERE "offlineNumber" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sales_tenant_device" ON "sales" ("tenantId", "deviceId", "deviceSequence") WHERE "deviceId" IS NOT NULL`,
    );

    await queryRunner.query(`
      ALTER TABLE "sale_items"
        ADD "taxRate" numeric(5,2),
        ADD "originalUnitPrice" numeric(19,4)`);

    // ---- Payment providers ----
    await queryRunner.query(
      `ALTER TABLE "payment_methods" ADD "provider" character varying(50) NOT NULL DEFAULT 'manual'`,
    );

    for (const value of [
      'initiated',
      'authorized',
      'captured',
      'cancelled',
      'unknown',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "public"."payments_status_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD "provider" character varying(50),
        ADD "providerReference" character varying(255),
        ADD "failureReason" character varying(255),
        ADD "authorizedAt" TIMESTAMP WITH TIME ZONE,
        ADD "capturedAt" TIMESTAMP WITH TIME ZONE,
        ADD "lastCheckedAt" TIMESTAMP WITH TIME ZONE,
        ADD "reconciledAt" TIMESTAMP WITH TIME ZONE,
        ADD "reconciliationNote" character varying(255)`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payment_idempotency" ON "payments" ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_payment_provider_reference" ON "payments" ("provider", "providerReference") WHERE "providerReference" IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "payment_webhook_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid,
        "provider" character varying(50) NOT NULL,
        "eventId" character varying(255) NOT NULL,
        "eventType" character varying(100) NOT NULL,
        "providerReference" character varying(255),
        "payload" jsonb NOT NULL DEFAULT '{}',
        "processedAt" TIMESTAMP WITH TIME ZONE,
        "error" character varying(500),
        CONSTRAINT "PK_payment_webhook_events" PRIMARY KEY ("id"),
        CONSTRAINT "uq_payment_webhook_event" UNIQUE ("provider", "eventId"),
        CONSTRAINT "FK_payment_webhook_events_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
      )`);

    await queryRunner.query(`
      CREATE TABLE "settlement_batches" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "provider" character varying(50) NOT NULL,
        "reference" character varying(100),
        "source" character varying(10) NOT NULL,
        "importedById" uuid,
        "lineCount" integer NOT NULL DEFAULT 0,
        "matchedCount" integer NOT NULL DEFAULT 0,
        "totalAmount" numeric(19,4) NOT NULL DEFAULT 0,
        "totalFees" numeric(19,4) NOT NULL DEFAULT 0,
        CONSTRAINT "PK_settlement_batches" PRIMARY KEY ("id"),
        CONSTRAINT "FK_settlement_batches_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_settlement_batches_tenant" ON "settlement_batches" ("tenantId", "created_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "settlement_lines" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "batchId" uuid NOT NULL,
        "reference" character varying(255) NOT NULL,
        "amount" numeric(19,4) NOT NULL,
        "fee" numeric(19,4) NOT NULL DEFAULT 0,
        "settledDate" date,
        "status" character varying(20) NOT NULL DEFAULT 'unmatched',
        "paymentId" uuid,
        "resolvedById" uuid,
        "resolvedAt" TIMESTAMP WITH TIME ZONE,
        "resolutionNote" character varying(255),
        CONSTRAINT "PK_settlement_lines" PRIMARY KEY ("id"),
        CONSTRAINT "FK_settlement_lines_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_settlement_lines_batch" FOREIGN KEY ("batchId") REFERENCES "settlement_batches"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_settlement_lines_payment" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE SET NULL
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_settlement_lines_tenant_status" ON "settlement_lines" ("tenantId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_settlement_lines_batch" ON "settlement_lines" ("batchId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_settlement_line_payment" ON "settlement_lines" ("paymentId") WHERE "paymentId" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "settlement_lines"`);
    await queryRunner.query(`DROP TABLE "settlement_batches"`);
    await queryRunner.query(`DROP TABLE "payment_webhook_events"`);

    await queryRunner.query(
      `DROP INDEX "public"."uq_payment_provider_reference"`,
    );
    await queryRunner.query(`DROP INDEX "public"."uq_payment_idempotency"`);
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP COLUMN "reconciliationNote",
        DROP COLUMN "reconciledAt",
        DROP COLUMN "lastCheckedAt",
        DROP COLUMN "capturedAt",
        DROP COLUMN "authorizedAt",
        DROP COLUMN "failureReason",
        DROP COLUMN "providerReference",
        DROP COLUMN "provider"`);
    // Postgres cannot drop enum values: map the new states onto the old ones and recreate the type
    await queryRunner.query(`
      UPDATE "payments" SET "status" = CASE
        WHEN "status"::text = 'captured' THEN 'completed'
        WHEN "status"::text IN ('initiated', 'authorized', 'unknown') THEN 'pending'
        WHEN "status"::text = 'cancelled' THEN 'failed'
        ELSE "status" END`);
    await queryRunner.query(
      `ALTER TYPE "public"."payments_status_enum" RENAME TO "payments_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payments_status_enum" AS ENUM('pending', 'completed', 'failed', 'refunded')`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" TYPE "public"."payments_status_enum" USING "status"::text::"public"."payments_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ALTER COLUMN "status" SET DEFAULT 'completed'`,
    );
    await queryRunner.query(`DROP TYPE "public"."payments_status_enum_old"`);

    await queryRunner.query(
      `ALTER TABLE "payment_methods" DROP COLUMN "provider"`,
    );

    await queryRunner.query(`
      ALTER TABLE "sale_items"
        DROP COLUMN "originalUnitPrice",
        DROP COLUMN "taxRate"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_sales_tenant_device"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_sales_tenant_offline_number"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_sales_tenant_shift"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_sales_tenant_status_register"`,
    );
    await queryRunner.query(`
      ALTER TABLE "sales"
        DROP COLUMN "heldLabel",
        DROP COLUMN "heldUntil",
        DROP COLUMN "receiptPrintCount",
        DROP COLUMN "deviceSequence",
        DROP COLUMN "deviceId",
        DROP COLUMN "offlineNumber",
        DROP COLUMN "shiftId"`);
    // Unfinished carts have no place in the old lifecycle
    await queryRunner.query(
      `DELETE FROM "sales" WHERE "status"::text IN ('held', 'payment_pending', 'cancelled')`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."sales_status_enum" RENAME TO "sales_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."sales_status_enum" AS ENUM('draft', 'completed', 'voided', 'refunded', 'partially_refunded')`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ALTER COLUMN "status" TYPE "public"."sales_status_enum" USING "status"::text::"public"."sales_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ALTER COLUMN "status" SET DEFAULT 'draft'`,
    );
    await queryRunner.query(`DROP TYPE "public"."sales_status_enum_old"`);
  }
}
