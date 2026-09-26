import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sales core features:
 * - sales.salespersonId: staff member credited with the sale (not the cashier)
 * - sales.documentSnapshot: seller identity frozen at completion, for reprints
 * - products.isStockTracked: services / non-stock items never move stock
 * - conflict_cases: review queue (offline oversells, unapproved offline prices, ...)
 * - permission sales.review, granted to the built-in owner, admin and manager roles
 *
 * Per-branch document numbers (D017) need no schema change: new numbers use the
 * branch code as prefix; existing sales and returns keep theirs.
 */
export class SalesCoreFeatures1790400000000 implements MigrationInterface {
  name = 'SalesCoreFeatures1790400000000';

  private readonly permissions = ['sales.review'];

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sales" ADD "salespersonId" uuid, ADD "documentSnapshot" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_sales_salesperson"
       FOREIGN KEY ("salespersonId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sales_tenant_salesperson" ON "sales" ("tenantId", "salespersonId")
       WHERE "salespersonId" IS NOT NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "products" ADD "isStockTracked" boolean NOT NULL DEFAULT true`,
    );

    await queryRunner.query(`
      CREATE TABLE "conflict_cases" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "type" character varying(30) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'open',
        "saleId" uuid,
        "deviceId" uuid,
        "details" jsonb NOT NULL DEFAULT '{}',
        "openedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "resolvedAt" TIMESTAMP WITH TIME ZONE,
        "resolvedById" uuid,
        "resolutionNote" character varying(500),
        CONSTRAINT "PK_conflict_cases" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_conflict_cases_status" CHECK ("status" IN ('open', 'resolved', 'dismissed')),
        CONSTRAINT "FK_conflict_cases_tenant" FOREIGN KEY ("tenantId")
          REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_conflict_cases_tenant_status" ON "conflict_cases" ("tenantId", "status", "openedAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_conflict_cases_sale" ON "conflict_cases" ("tenantId", "saleId")
       WHERE "saleId" IS NOT NULL`,
    );

    for (const key of this.permissions) {
      await queryRunner.query(
        `UPDATE "tenant_roles" SET "permissions" = "permissions" || jsonb_build_array($1::text)
         WHERE "isSystem" = true AND "key" IN ('owner', 'admin', 'manager') AND NOT "permissions" ? $1`,
        [key],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const key of this.permissions) {
      await queryRunner.query(
        `UPDATE "tenant_roles" SET "permissions" = "permissions" - $1::text WHERE "permissions" ? $1`,
        [key],
      );
    }
    await queryRunner.query(`DROP TABLE "conflict_cases"`);
    await queryRunner.query(
      `ALTER TABLE "products" DROP COLUMN "isStockTracked"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_sales_tenant_salesperson"`);
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_sales_salesperson"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP COLUMN "documentSnapshot", DROP COLUMN "salespersonId"`,
    );
  }
}
