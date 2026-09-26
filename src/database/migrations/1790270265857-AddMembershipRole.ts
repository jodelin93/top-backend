import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMembershipRole1790270265857 implements MigrationInterface {
  name = 'AddMembershipRole1790270265857';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."tenant_memberships_role_enum" AS ENUM('owner', 'admin', 'manager', 'cashier')`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ADD "role" "public"."tenant_memberships_role_enum" NOT NULL DEFAULT 'cashier'`,
    );
    // Memberships that predate roles belong to the tenants' original admins
    await queryRunner.query(`UPDATE "tenant_memberships" SET "role" = 'owner'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" DROP COLUMN "role"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."tenant_memberships_role_enum"`,
    );
  }
}
