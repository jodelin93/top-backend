import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reports (spec §14):
 * - export_jobs: background report exports. A worker claims queued jobs with
 *   FOR UPDATE SKIP LOCKED, writes the file to private storage (fileKey) and the
 *   file is deleted after expiresAt.
 * - saved_report_filters: named report parameters per user, optionally shared
 *   with everyone who can view reports.
 */
export class ReportsExports1790530000000 implements MigrationInterface {
  name = 'ReportsExports1790530000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "export_jobs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "reportKey" character varying(100) NOT NULL,
        "params" jsonb NOT NULL DEFAULT '{}',
        "scope" jsonb,
        "format" character varying(10) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'queued',
        "attempts" integer NOT NULL DEFAULT 0,
        "rowCount" integer,
        "fileKey" character varying(300),
        "fileName" character varying(255),
        "fileSize" bigint,
        "startedAt" TIMESTAMP WITH TIME ZONE,
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        "error" character varying(1000),
        CONSTRAINT "CHK_export_jobs_format" CHECK ("format" IN ('csv', 'xlsx', 'pdf')),
        CONSTRAINT "CHK_export_jobs_status" CHECK ("status" IN ('queued', 'running', 'done', 'failed', 'expired')),
        CONSTRAINT "PK_export_jobs" PRIMARY KEY ("id"),
        CONSTRAINT "FK_export_jobs_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_export_jobs_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )`);
    // The worker's queue: oldest queued first
    await queryRunner.query(
      `CREATE INDEX "IDX_export_jobs_queued" ON "export_jobs" ("created_at") WHERE "status" = 'queued'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_export_jobs_expiry" ON "export_jobs" ("expiresAt") WHERE "fileKey" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_export_jobs_tenant_user" ON "export_jobs" ("tenantId", "userId", "created_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "saved_report_filters" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "reportKey" character varying(100) NOT NULL,
        "name" character varying(100) NOT NULL,
        "params" jsonb NOT NULL DEFAULT '{}',
        "shared" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_saved_report_filters" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_saved_report_filters_name" UNIQUE ("tenantId", "userId", "reportKey", "name"),
        CONSTRAINT "FK_saved_report_filters_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_saved_report_filters_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_saved_report_filters_report" ON "saved_report_filters" ("tenantId", "reportKey")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "saved_report_filters"`);
    await queryRunner.query(`DROP TABLE "export_jobs"`);
  }
}
