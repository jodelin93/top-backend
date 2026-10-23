import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * sales.view now shows only the sales the user rang up; sales.view.all shows
 * every sale. Given to the built-in owner, admin and manager roles, and to the
 * custom roles that could see sales until now (nothing changes for them). The
 * built-in cashier role keeps sales.view only: cashiers see their own sales.
 */
export class ViewAllSales1790830000000 implements MigrationInterface {
  name = 'ViewAllSales1790830000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" || jsonb_build_array('sales.view.all'::text)
        WHERE NOT "permissions" ? 'sales.view.all'
          AND (("isSystem" = true AND "key" IN ('owner', 'admin', 'manager'))
            OR ("isSystem" = false AND "permissions" ? 'sales.view'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" - 'sales.view.all'::text WHERE "permissions" ? 'sales.view.all'`,
    );
  }
}
