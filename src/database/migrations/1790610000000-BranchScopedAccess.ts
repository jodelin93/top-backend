import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Branch-level access (spec §3/§9, AC15):
 *
 * - tenant_memberships."branchIds": the branches a member works in; NULL = every
 *   branch (the default, so existing members keep their access). Owners always
 *   have every branch whatever is stored.
 * - branch_warehouses: which warehouses serve which branches. A branch-limited
 *   member sees and moves the stock of these warehouses' locations only.
 *   Backfilled from each register's default stock location (the warehouse its
 *   branch already sells from).
 */
export class BranchScopedAccess1790610000000 implements MigrationInterface {
  name = 'BranchScopedAccess1790610000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ADD "branchIds" uuid[]`,
    );

    await queryRunner.query(`
      CREATE TABLE "branch_warehouses" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "branchId" uuid NOT NULL,
        "warehouseId" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_branch_warehouses" PRIMARY KEY ("id"),
        CONSTRAINT "FK_branch_warehouses_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_branch_warehouses_branch" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_branch_warehouses_warehouse" FOREIGN KEY ("warehouseId") REFERENCES "warehouses"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_branch_warehouses" ON "branch_warehouses" ("branchId", "warehouseId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_branch_warehouses_tenant_warehouse" ON "branch_warehouses" ("tenantId", "warehouseId")`,
    );

    // Each branch works from the warehouses its registers sell from
    await queryRunner.query(`
      INSERT INTO "branch_warehouses" ("tenantId", "branchId", "warehouseId")
      SELECT DISTINCT r."tenantId", r."branchId", l."warehouseId"
      FROM "registers" r
      JOIN "inventory_locations" l
        ON l.id = r."defaultLocationId" AND l."tenantId" = r."tenantId"
      ON CONFLICT ("branchId", "warehouseId") DO NOTHING`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "branch_warehouses"`);
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" DROP COLUMN "branchIds"`,
    );
  }
}
