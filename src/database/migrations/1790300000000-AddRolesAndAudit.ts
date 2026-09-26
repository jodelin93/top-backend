import { MigrationInterface, QueryRunner } from 'typeorm';
import { SYSTEM_ROLES } from '../../auth/permissions';

export class AddRolesAndAudit1790300000000 implements MigrationInterface {
  name = 'AddRolesAndAudit1790300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- Configurable roles ----
    await queryRunner.query(`
      CREATE TABLE "tenant_roles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "key" character varying(50) NOT NULL,
        "name" character varying(100) NOT NULL,
        "description" character varying(255),
        "permissions" jsonb NOT NULL DEFAULT '[]',
        "isSystem" boolean NOT NULL DEFAULT false,
        CONSTRAINT "uq_tenant_role_key" UNIQUE ("tenantId", "key"),
        CONSTRAINT "PK_tenant_roles" PRIMARY KEY ("id"),
        CONSTRAINT "FK_tenant_roles_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_tenant_roles_tenant" ON "tenant_roles" ("tenantId")`,
    );

    // Built-in roles for every existing store
    for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
      await queryRunner.query(
        `INSERT INTO "tenant_roles" ("tenantId", "key", "name", "description", "permissions", "isSystem")
         SELECT id, $1, $2, $3, $4::jsonb, true FROM "tenants"`,
        [key, role.name, role.description, JSON.stringify(role.permissions)],
      );
    }

    // Memberships reference roles by key instead of a fixed enum
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ALTER COLUMN "role" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ALTER COLUMN "role" TYPE character varying(50) USING "role"::text`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ALTER COLUMN "role" SET DEFAULT 'cashier'`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."tenant_memberships_role_enum"`,
    );

    // ---- Audit log ----
    await queryRunner.query(`
      CREATE TABLE "audit_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "actorId" uuid,
        "approverId" uuid,
        "action" character varying(100) NOT NULL,
        "entityType" character varying(50) NOT NULL,
        "entityId" character varying(100),
        "reason" character varying(500),
        "changes" jsonb,
        "metadata" jsonb NOT NULL DEFAULT '{}',
        "ip" character varying(64),
        "requestId" character varying(128),
        CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_tenant_created" ON "audit_logs" ("tenantId", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_tenant_entity" ON "audit_logs" ("tenantId", "entityType", "entityId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_audit_tenant_action" ON "audit_logs" ("tenantId", "action")`,
    );

    // Append-only: rows can never be changed, and only deleted by an explicit purge
    // (SET LOCAL app.audit_purge = 'on'), e.g. when a whole test tenant is removed
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION audit_logs_append_only() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'audit_logs is append-only';
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(`
      CREATE TRIGGER "trg_audit_logs_append_only"
      BEFORE UPDATE OR DELETE ON "audit_logs"
      FOR EACH ROW EXECUTE FUNCTION audit_logs_append_only()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER "trg_audit_logs_append_only" ON "audit_logs"`,
    );
    await queryRunner.query(`DROP FUNCTION audit_logs_append_only()`);
    await queryRunner.query(`DROP TABLE "audit_logs"`);
    await queryRunner.query(
      `CREATE TYPE "public"."tenant_memberships_role_enum" AS ENUM('owner', 'admin', 'manager', 'cashier')`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ALTER COLUMN "role" DROP DEFAULT`,
    );
    // Custom roles have no enum value; demote them to cashier
    await queryRunner.query(
      `UPDATE "tenant_memberships" SET "role" = 'cashier' WHERE "role" NOT IN ('owner', 'admin', 'manager', 'cashier')`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ALTER COLUMN "role" TYPE "public"."tenant_memberships_role_enum" USING "role"::"public"."tenant_memberships_role_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ALTER COLUMN "role" SET DEFAULT 'cashier'`,
    );
    await queryRunner.query(`DROP TABLE "tenant_roles"`);
  }
}
