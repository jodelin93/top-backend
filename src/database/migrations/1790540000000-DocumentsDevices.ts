import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Documents & hardware (spec §15):
 *
 * - print_jobs: every print of a document (receipt, invoice, credit note, pro forma,
 *   Z-report, label) with its outcome. One live original per document
 *   (UQ_print_jobs_original); later prints are numbered copies.
 * - document_deliveries: e-mailed receipts and shared receipt links (SMS/WhatsApp),
 *   with the consent basis and status.
 * - device_hardware: last print-bridge / printer report of each till.
 * - receiptFormat 'letter' is a new settings value (settings are JSON on the
 *   tenant: nothing to migrate).
 * - Permissions:
 *   sales.reprint (reprint a receipt as COPY, e-mail or share it) for the built-in
 *   owner/admin/manager/cashier roles and every role that could reprint until now
 *   (sales.view);
 *   hardware.manage (pair the print bridge, test the printer and cash drawer) for
 *   owner/admin/manager and roles holding devices.manage or settings.manage.
 */
export class DocumentsDevices1790540000000 implements MigrationInterface {
  name = 'DocumentsDevices1790540000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "print_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "documentType" character varying(20) NOT NULL,
        "documentId" uuid NOT NULL,
        "documentNumber" character varying(100),
        "copy" boolean NOT NULL DEFAULT false,
        "copyNumber" integer,
        "deviceId" uuid,
        "printerId" character varying(100),
        "channel" character varying(10) NOT NULL DEFAULT 'browser',
        "status" character varying(10) NOT NULL DEFAULT 'queued',
        "error" text,
        "retryOfId" uuid,
        "userId" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_print_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_print_jobs_type" CHECK ("documentType" IN ('receipt', 'invoice', 'credit_note', 'pro_forma', 'z_report', 'label')),
        CONSTRAINT "CHK_print_jobs_status" CHECK ("status" IN ('queued', 'sent', 'printed', 'failed', 'unknown')),
        CONSTRAINT "CHK_print_jobs_channel" CHECK ("channel" IN ('bridge', 'browser')),
        CONSTRAINT "CHK_print_jobs_copy_number" CHECK (("copy" = false AND "copyNumber" IS NULL) OR ("copy" = true AND "copyNumber" >= 1)),
        CONSTRAINT "FK_print_jobs_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_print_jobs_retry_of" FOREIGN KEY ("retryOfId") REFERENCES "print_jobs"("id") ON DELETE SET NULL
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_print_jobs_document" ON "print_jobs" ("tenantId", "documentType", "documentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_print_jobs_tenant_created" ON "print_jobs" ("tenantId", "createdAt")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_print_jobs_original" ON "print_jobs" ("tenantId", "documentType", "documentId") WHERE "copy" = false AND "status" IN ('queued', 'sent', 'printed', 'unknown')`,
    );

    await queryRunner.query(`
      CREATE TABLE "document_deliveries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "documentType" character varying(20) NOT NULL,
        "documentId" uuid NOT NULL,
        "channel" character varying(10) NOT NULL,
        "recipient" character varying(255),
        "status" character varying(10) NOT NULL DEFAULT 'queued',
        "error" text,
        "consentBasis" character varying(20),
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        "userId" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_document_deliveries" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_document_deliveries_channel" CHECK ("channel" IN ('email', 'sms_link')),
        CONSTRAINT "CHK_document_deliveries_status" CHECK ("status" IN ('queued', 'sent', 'failed', 'revoked')),
        CONSTRAINT "CHK_document_deliveries_consent" CHECK ("channel" <> 'email' OR "consentBasis" IS NOT NULL),
        CONSTRAINT "FK_document_deliveries_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_document_deliveries_document" ON "document_deliveries" ("tenantId", "documentType", "documentId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "device_hardware" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "deviceId" uuid NOT NULL,
        "bridgePaired" boolean NOT NULL DEFAULT false,
        "bridgeReachable" boolean NOT NULL DEFAULT false,
        "bridgeVersion" character varying(30),
        "printers" jsonb NOT NULL DEFAULT '[]',
        "customerDisplay" boolean NOT NULL DEFAULT false,
        "reportedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "reportedBy" uuid,
        CONSTRAINT "PK_device_hardware" PRIMARY KEY ("id"),
        CONSTRAINT "FK_device_hardware_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_device_hardware_device" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_device_hardware_device" ON "device_hardware" ("tenantId", "deviceId")`,
    );

    // ---- Permissions ----
    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" || jsonb_build_array('sales.reprint'::text)
       WHERE (("isSystem" = true AND "key" IN ('owner', 'admin', 'manager', 'cashier')) OR "permissions" ? 'sales.view')
         AND NOT "permissions" ? 'sales.reprint'`,
    );
    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" || jsonb_build_array('hardware.manage'::text)
       WHERE (("isSystem" = true AND "key" IN ('owner', 'admin', 'manager'))
              OR "permissions" ? 'devices.manage' OR "permissions" ? 'settings.manage')
         AND NOT "permissions" ? 'hardware.manage'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const key of ['sales.reprint', 'hardware.manage']) {
      await queryRunner.query(
        `UPDATE "tenant_roles" SET "permissions" = "permissions" - $1::text WHERE "permissions" ? $1`,
        [key],
      );
    }
    await queryRunner.query(`DROP TABLE "device_hardware"`);
    await queryRunner.query(`DROP TABLE "document_deliveries"`);
    await queryRunner.query(`DROP TABLE "print_jobs"`);
  }
}
