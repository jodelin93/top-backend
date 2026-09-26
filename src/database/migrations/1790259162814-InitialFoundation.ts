import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialFoundation1790259162814 implements MigrationInterface {
  name = 'InitialFoundation1790259162814';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."tenant_memberships_status_enum" AS ENUM('active', 'suspended')`,
    );
    await queryRunner.query(
      `CREATE TABLE "tenant_memberships" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "userId" uuid NOT NULL, "status" "public"."tenant_memberships_status_enum" NOT NULL DEFAULT 'active', "joinedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "leftAt" TIMESTAMP WITH TIME ZONE, "tenant_id" uuid, "user_id" uuid, CONSTRAINT "uq_tenant_user" UNIQUE ("tenantId", "userId"), CONSTRAINT "PK_706d16104745b32d75df5836135" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_aff7ff5f171848da8169885b85" ON "tenant_memberships"  ("userId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f2a716ce4ea37745564baaccda" ON "tenant_memberships"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."users_status_enum" AS ENUM('active', 'suspended', 'deleted')`,
    );
    await queryRunner.query(
      `CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "email" character varying(255) NOT NULL, "passwordHash" character varying(255) NOT NULL, "firstName" character varying(100), "lastName" character varying(100), "phone" character varying(50), "locale" character varying(10) NOT NULL DEFAULT 'en', "timezone" character varying(50) NOT NULL DEFAULT 'UTC', "mfaEnabled" boolean NOT NULL DEFAULT false, "mfaSecret" character varying(255), "status" "public"."users_status_enum" NOT NULL DEFAULT 'active', "lastLoginAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_2983d03507184c5b52cd14c94d" ON "users"  ("status") WHERE status = 'active'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_97672ac88f789774dd47f7c8be" ON "users"  ("email") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."tenants_status_enum" AS ENUM('active', 'suspended', 'deleted')`,
    );
    await queryRunner.query(
      `CREATE TABLE "tenants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "name" character varying(255) NOT NULL, "slug" character varying(100) NOT NULL, "status" "public"."tenants_status_enum" NOT NULL DEFAULT 'active', "settings" jsonb NOT NULL DEFAULT '{}', CONSTRAINT "UQ_2310ecc5cb8be427097154b18fc" UNIQUE ("slug"), CONSTRAINT "PK_53be67a04681c66b87ee27c9321" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_45f3140406cc48bcbb23cd69a7" ON "tenants"  ("status") WHERE status = 'active'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_2310ecc5cb8be427097154b18f" ON "tenants"  ("slug") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."warehouses_warehousetype_enum" AS ENUM('standard', 'transit', 'quarantine')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."warehouses_status_enum" AS ENUM('active', 'inactive')`,
    );
    await queryRunner.query(
      `CREATE TABLE "warehouses" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" character varying(255) NOT NULL, "warehouseType" "public"."warehouses_warehousetype_enum" NOT NULL DEFAULT 'standard', "addressLine1" character varying(255), "addressLine2" character varying(255), "city" character varying(100), "stateProvince" character varying(100), "postalCode" character varying(20), "countryCode" character(2), "status" "public"."warehouses_status_enum" NOT NULL DEFAULT 'active', "tenant_id" uuid, CONSTRAINT "uq_warehouse_id_tenant" UNIQUE ("id", "tenantId"), CONSTRAINT "uq_warehouse_code" UNIQUE ("tenantId", "code"), CONSTRAINT "PK_56ae21ee2432b2270b48867e4be" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c747b0a69a22b026c99bac8b10" ON "warehouses"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."inventory_locations_locationtype_enum" AS ENUM('bin', 'aisle', 'zone')`,
    );
    await queryRunner.query(
      `CREATE TABLE "inventory_locations" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "warehouseId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" character varying(255), "locationType" "public"."inventory_locations_locationtype_enum" NOT NULL DEFAULT 'bin', "isSellable" boolean NOT NULL DEFAULT true, "tenant_id" uuid, "warehouse_id" uuid, CONSTRAINT "uq_location_id_tenant" UNIQUE ("id", "tenantId"), CONSTRAINT "uq_location_code" UNIQUE ("warehouseId", "code"), CONSTRAINT "PK_b9591ced2c9d787495d19639575" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c00e99807ffc897b08c8934201" ON "inventory_locations"  ("warehouseId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."registers_status_enum" AS ENUM('active', 'inactive')`,
    );
    await queryRunner.query(
      `CREATE TABLE "registers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "branchId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" character varying(255) NOT NULL, "defaultLocationId" uuid, "drawerId" uuid, "settings" jsonb NOT NULL DEFAULT '{}', "status" "public"."registers_status_enum" NOT NULL DEFAULT 'active', "tenant_id" uuid, "branch_id" uuid, "default_location_id" uuid, CONSTRAINT "uq_register_code" UNIQUE ("tenantId", "code"), CONSTRAINT "PK_c80e46007c1de9f8d1c59b3b9b9" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f9b1258e670efb6f8a36d962f0" ON "registers"  ("branchId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."branches_status_enum" AS ENUM('active', 'inactive')`,
    );
    await queryRunner.query(
      `CREATE TABLE "branches" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" character varying(255) NOT NULL, "addressLine1" character varying(255), "addressLine2" character varying(255), "city" character varying(100), "stateProvince" character varying(100), "postalCode" character varying(20), "countryCode" character(2), "phone" character varying(50), "email" character varying(255), "timezone" character varying(50) NOT NULL DEFAULT 'UTC', "currencyCode" character(3) NOT NULL, "taxNumber" character varying(100), "settings" jsonb NOT NULL DEFAULT '{}', "status" "public"."branches_status_enum" NOT NULL DEFAULT 'active', "tenant_id" uuid, CONSTRAINT "uq_branch_id_tenant" UNIQUE ("id", "tenantId"), CONSTRAINT "uq_branch_code" UNIQUE ("tenantId", "code"), CONSTRAINT "PK_7f37d3b42defea97f1df0d19535" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3e42c6b3081d9e6f0c036c6ce4" ON "branches"  ("status") WHERE status = 'active'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_19db6a12993aa421cc98437663" ON "branches"  ("tenantId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ADD CONSTRAINT "FK_d22937ebccd641b5090849e51f7" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" ADD CONSTRAINT "FK_7427b391abdef33b40124c15822" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "warehouses" ADD CONSTRAINT "FK_09106b8068aeaf74fa33666df8f" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" ADD CONSTRAINT "FK_83abf141eab6cd74db8eaced29d" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" ADD CONSTRAINT "FK_b89597faae660724b796ff4b572" FOREIGN KEY ("warehouse_id", "tenant_id") REFERENCES "warehouses"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" ADD CONSTRAINT "FK_b923656be8487cea6434cb56a08" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" ADD CONSTRAINT "FK_6da077559e6c8a8fcc4893b790f" FOREIGN KEY ("branch_id", "tenant_id") REFERENCES "branches"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" ADD CONSTRAINT "FK_e80e7e392753f6aafdd45bc05c6" FOREIGN KEY ("default_location_id", "tenant_id") REFERENCES "inventory_locations"("id","tenantId") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "branches" ADD CONSTRAINT "FK_fda619979f40a6a44fc9baf02c3" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "branches" DROP CONSTRAINT "FK_fda619979f40a6a44fc9baf02c3"`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" DROP CONSTRAINT "FK_e80e7e392753f6aafdd45bc05c6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" DROP CONSTRAINT "FK_6da077559e6c8a8fcc4893b790f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" DROP CONSTRAINT "FK_b923656be8487cea6434cb56a08"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" DROP CONSTRAINT "FK_b89597faae660724b796ff4b572"`,
    );
    await queryRunner.query(
      `ALTER TABLE "inventory_locations" DROP CONSTRAINT "FK_83abf141eab6cd74db8eaced29d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "warehouses" DROP CONSTRAINT "FK_09106b8068aeaf74fa33666df8f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" DROP CONSTRAINT "FK_7427b391abdef33b40124c15822"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tenant_memberships" DROP CONSTRAINT "FK_d22937ebccd641b5090849e51f7"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_19db6a12993aa421cc98437663"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3e42c6b3081d9e6f0c036c6ce4"`,
    );
    await queryRunner.query(`DROP TABLE "branches"`);
    await queryRunner.query(`DROP TYPE "public"."branches_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f9b1258e670efb6f8a36d962f0"`,
    );
    await queryRunner.query(`DROP TABLE "registers"`);
    await queryRunner.query(`DROP TYPE "public"."registers_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_c00e99807ffc897b08c8934201"`,
    );
    await queryRunner.query(`DROP TABLE "inventory_locations"`);
    await queryRunner.query(
      `DROP TYPE "public"."inventory_locations_locationtype_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_c747b0a69a22b026c99bac8b10"`,
    );
    await queryRunner.query(`DROP TABLE "warehouses"`);
    await queryRunner.query(`DROP TYPE "public"."warehouses_status_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."warehouses_warehousetype_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_2310ecc5cb8be427097154b18f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_45f3140406cc48bcbb23cd69a7"`,
    );
    await queryRunner.query(`DROP TABLE "tenants"`);
    await queryRunner.query(`DROP TYPE "public"."tenants_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_97672ac88f789774dd47f7c8be"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_2983d03507184c5b52cd14c94d"`,
    );
    await queryRunner.query(`DROP TABLE "users"`);
    await queryRunner.query(`DROP TYPE "public"."users_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f2a716ce4ea37745564baaccda"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_aff7ff5f171848da8169885b85"`,
    );
    await queryRunner.query(`DROP TABLE "tenant_memberships"`);
    await queryRunner.query(
      `DROP TYPE "public"."tenant_memberships_status_enum"`,
    );
  }
}
