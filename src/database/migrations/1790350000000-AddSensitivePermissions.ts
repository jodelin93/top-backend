import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * New permissions guarding sensitive data and refunds:
 * inventory.cost.view, customers.finance.view, sales.refund.any_method.
 * Granted to the built-in owner, admin and manager roles (not cashier).
 */
export class AddSensitivePermissions1790350000000 implements MigrationInterface {
  name = 'AddSensitivePermissions1790350000000';

  private readonly keys = [
    'inventory.cost.view',
    'customers.finance.view',
    'sales.refund.any_method',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const key of this.keys) {
      await queryRunner.query(
        `UPDATE "tenant_roles" SET "permissions" = "permissions" || jsonb_build_array($1::text)
         WHERE "isSystem" = true AND "key" IN ('owner', 'admin', 'manager') AND NOT "permissions" ? $1`,
        [key],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const key of this.keys) {
      await queryRunner.query(
        `UPDATE "tenant_roles" SET "permissions" = "permissions" - $1::text WHERE "permissions" ? $1`,
        [key],
      );
    }
  }
}
