import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Staff and drawers (spec §13):
 * - employees (HR records, optionally linked to a login), their branches and
 *   attendance (clock in / out)
 * - drawers: one per register (replaces registers."drawerId"), drawer policy per
 *   register, shifts per drawer (the one-active-shift index moves from the
 *   register to the drawer), shift handover columns and closed-shift corrections
 * - cash movement types 'sale' (per-sale drawer ledger) and 'no_sale'
 * - business date on shifts and sales (branch timezone + store
 *   businessDayCutoffHour); sales get it from a trigger
 * - lost devices
 * - permission employees.manage for the owner, admin and manager roles
 */
export class EmployeesDrawers1790510000000 implements MigrationInterface {
  name = 'EmployeesDrawers1790510000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- Cash movement types (not used in this migration: safe inside the transaction)
    for (const value of ['sale', 'no_sale']) {
      await queryRunner.query(
        `ALTER TYPE "public"."cash_movements_type_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }

    // ---- Employees
    await queryRunner.query(
      `CREATE TABLE "employees" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL DEFAULT '1', "tenantId" uuid NOT NULL, "userId" uuid, "firstName" character varying(100) NOT NULL, "lastName" character varying(100) NOT NULL, "jobTitle" character varying(100), "phone" character varying(50), "email" character varying(255), "employeeCode" character varying(50), "status" character varying(20) NOT NULL DEFAULT 'active', "hireDate" date, "terminationDate" date, "notes" character varying(2000), CONSTRAINT "CHK_employees_status" CHECK ("status" IN ('active', 'inactive')), CONSTRAINT "PK_employees" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employees_tenant_status" ON "employees" ("tenantId", "status")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_employee_code" ON "employees" ("tenantId", "employeeCode") WHERE "employeeCode" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_employee_user" ON "employees" ("tenantId", "userId") WHERE "userId" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "employees" ADD CONSTRAINT "FK_employees_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "employees" ADD CONSTRAINT "FK_employees_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `CREATE TABLE "employee_branches" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "employeeId" uuid NOT NULL, "branchId" uuid NOT NULL, "isPrimary" boolean NOT NULL DEFAULT false, CONSTRAINT "PK_employee_branches" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_employee_branch" ON "employee_branches" ("employeeId", "branchId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_employee_primary_branch" ON "employee_branches" ("employeeId") WHERE "isPrimary" = true`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_branches_branch" ON "employee_branches" ("tenantId", "branchId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee_branches" ADD CONSTRAINT "FK_employee_branches_employee" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee_branches" ADD CONSTRAINT "FK_employee_branches_branch" FOREIGN KEY ("branchId") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `CREATE TABLE "employee_attendance" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "employeeId" uuid NOT NULL, "clockIn" TIMESTAMP WITH TIME ZONE NOT NULL, "clockOut" TIMESTAMP WITH TIME ZONE, "branchId" uuid, "source" character varying(10) NOT NULL, "note" character varying(500), "recordedById" uuid, CONSTRAINT "CHK_employee_attendance_source" CHECK ("source" IN ('pos', 'admin')), CONSTRAINT "CHK_employee_attendance_order" CHECK ("clockOut" IS NULL OR "clockOut" >= "clockIn"), CONSTRAINT "PK_employee_attendance" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_attendance_employee" ON "employee_attendance" ("tenantId", "employeeId", "clockIn")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_employee_attendance_tenant" ON "employee_attendance" ("tenantId", "clockIn")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_employee_attendance_open" ON "employee_attendance" ("employeeId") WHERE "clockOut" IS NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "employee_attendance" ADD CONSTRAINT "FK_employee_attendance_employee" FOREIGN KEY ("employeeId") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // ---- Drawers (one per register; an existing registers."drawerId" keeps its id)
    await queryRunner.query(
      `CREATE TABLE "drawers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL DEFAULT '1', "tenantId" uuid NOT NULL, "registerId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" character varying(100) NOT NULL, "status" character varying(20) NOT NULL DEFAULT 'active', CONSTRAINT "CHK_drawers_status" CHECK ("status" IN ('active', 'inactive')), CONSTRAINT "PK_drawers" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_drawer_code" ON "drawers" ("tenantId", "registerId", "code")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_drawers_register" ON "drawers" ("tenantId", "registerId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "drawers" ADD CONSTRAINT "FK_drawers_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "drawers" ADD CONSTRAINT "FK_drawers_register" FOREIGN KEY ("registerId") REFERENCES "registers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `INSERT INTO "drawers" ("id", "tenantId", "registerId", "code", "name", "status")
       SELECT COALESCE(r."drawerId", uuid_generate_v4()), r."tenantId", r."id", 'MAIN', 'Main drawer', 'active'
       FROM "registers" r`,
    );
    await queryRunner.query(`ALTER TABLE "registers" DROP COLUMN "drawerId"`);
    await queryRunner.query(
      `ALTER TABLE "registers" ADD "drawerPolicy" character varying(20) NOT NULL DEFAULT 'assigned'`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" ADD CONSTRAINT "CHK_registers_drawer_policy" CHECK ("drawerPolicy" IN ('assigned', 'shared'))`,
    );
    // Every new register gets its main drawer, whoever creates it (settings, setup, seeds)
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION pos_register_main_drawer() RETURNS trigger AS $$
       BEGIN
         INSERT INTO "drawers" ("tenantId", "registerId", "code", "name", "status")
         VALUES (NEW."tenantId", NEW."id", 'MAIN', 'Main drawer', 'active')
         ON CONFLICT DO NOTHING;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_registers_main_drawer" AFTER INSERT ON "registers"
       FOR EACH ROW EXECUTE FUNCTION pos_register_main_drawer()`,
    );

    // ---- Business date: local date in the branch timezone, day starting at the cutoff hour
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION pos_business_date(at timestamptz, tz text, cutoff integer)
       RETURNS date AS $$
       DECLARE
         hours integer := LEAST(GREATEST(COALESCE(cutoff, 0), 0), 23);
       BEGIN
         IF at IS NULL THEN RETURN NULL; END IF;
         BEGIN
           RETURN ((at AT TIME ZONE COALESCE(NULLIF(tz, ''), 'UTC')) - make_interval(hours => hours))::date;
         EXCEPTION WHEN others THEN
           -- Unknown timezone name: fall back to UTC rather than failing the write
           RETURN ((at AT TIME ZONE 'UTC') - make_interval(hours => hours))::date;
         END;
       END;
       $$ LANGUAGE plpgsql STABLE`,
    );
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION pos_store_cutoff(tenant uuid) RETURNS integer AS $$
         SELECT CASE WHEN (t.settings->>'businessDayCutoffHour') ~ '^[0-9]{1,2}$'
                     THEN (t.settings->>'businessDayCutoffHour')::integer ELSE 0 END
         FROM "tenants" t WHERE t."id" = tenant
       $$ LANGUAGE sql STABLE`,
    );

    // ---- Shifts: per drawer, shared, business date, handover
    await queryRunner.query(`ALTER TABLE "shifts"
      ADD "drawerId" uuid,
      ADD "shared" boolean NOT NULL DEFAULT false,
      ADD "businessDate" date,
      ADD "previousShiftId" uuid,
      ADD "handedOverToId" uuid`);
    await queryRunner.query(
      `UPDATE "shifts" sh SET "drawerId" = d."id"
       FROM "drawers" d
       WHERE d."registerId" = sh."registerId" AND d."code" = 'MAIN'`,
    );
    await queryRunner.query(
      `ALTER TABLE "shifts" ALTER COLUMN "drawerId" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "shifts" ADD CONSTRAINT "FK_shifts_drawer" FOREIGN KEY ("drawerId") REFERENCES "drawers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_shift_register_active"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_shift_drawer_active" ON "shifts" ("tenantId", "drawerId") WHERE "status" IN ('open', 'closing')`,
    );
    await queryRunner.query(
      `UPDATE "shifts" sh SET "businessDate" = pos_business_date(sh."openedAt", b."timezone", pos_store_cutoff(sh."tenantId"))
       FROM "registers" r JOIN "branches" b ON b."id" = r."branchId"
       WHERE r."id" = sh."registerId"`,
    );
    await queryRunner.query(
      `UPDATE "shifts" SET "businessDate" = pos_business_date("openedAt", 'UTC', pos_store_cutoff("tenantId"))
       WHERE "businessDate" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_shifts_business_date" ON "shifts" ("tenantId", "businessDate")`,
    );

    await queryRunner.query(
      `CREATE TABLE "shift_corrections" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "shiftId" uuid NOT NULL, "type" character varying(20) NOT NULL, "amount" numeric(19,4) NOT NULL, "reason" character varying(500) NOT NULL, "createdById" uuid NOT NULL, "approvedById" uuid NOT NULL, CONSTRAINT "CHK_shift_corrections_type" CHECK ("type" IN ('expected', 'counted')), CONSTRAINT "CHK_shift_corrections_amount" CHECK ("amount" <> 0), CONSTRAINT "PK_shift_corrections" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_shift_corrections_shift" ON "shift_corrections" ("tenantId", "shiftId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "shift_corrections" ADD CONSTRAINT "FK_shift_corrections_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "shift_corrections" ADD CONSTRAINT "FK_shift_corrections_shift" FOREIGN KEY ("shiftId") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "shift_corrections" ADD CONSTRAINT "FK_shift_corrections_approved_by" FOREIGN KEY ("approvedById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );

    // ---- Sales: business date, stamped by a trigger on every insert / saleDate change
    await queryRunner.query(`ALTER TABLE "sales" ADD "businessDate" date`);
    await queryRunner.query(
      `UPDATE "sales" s SET "businessDate" = pos_business_date(s."saleDate", b."timezone", pos_store_cutoff(s."tenantId"))
       FROM "branches" b WHERE b."id" = s."branchId"`,
    );
    await queryRunner.query(
      `UPDATE "sales" SET "businessDate" = pos_business_date("saleDate", 'UTC', pos_store_cutoff("tenantId"))
       WHERE "businessDate" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sales_business_date" ON "sales" ("tenantId", "businessDate")`,
    );
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION pos_sales_business_date() RETURNS trigger AS $$
       BEGIN
         NEW."businessDate" := pos_business_date(
           NEW."saleDate",
           (SELECT b."timezone" FROM "branches" b WHERE b."id" = NEW."branchId"),
           pos_store_cutoff(NEW."tenantId"));
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_sales_business_date" BEFORE INSERT OR UPDATE OF "saleDate", "branchId" ON "sales"
       FOR EACH ROW EXECUTE FUNCTION pos_sales_business_date()`,
    );

    // ---- Lost devices
    await queryRunner.query(`ALTER TABLE "devices"
      ADD "lostAt" TIMESTAMP WITH TIME ZONE,
      ADD "lostBy" uuid,
      ADD "lostUnsyncedCount" integer`);

    // ---- Permission
    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" || jsonb_build_array($1::text)
       WHERE "isSystem" = true AND "key" IN ('owner', 'admin', 'manager') AND NOT "permissions" ? $1`,
      ['employees.manage'],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" - $1::text WHERE "permissions" ? $1`,
      ['employees.manage'],
    );
    await queryRunner.query(`ALTER TABLE "devices"
      DROP COLUMN "lostUnsyncedCount", DROP COLUMN "lostBy", DROP COLUMN "lostAt"`);

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_sales_business_date" ON "sales"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS pos_sales_business_date()`,
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sales_business_date"`);
    await queryRunner.query(`ALTER TABLE "sales" DROP COLUMN "businessDate"`);

    await queryRunner.query(`DROP TABLE "shift_corrections"`);

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_shifts_business_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_shift_drawer_active"`);
    // Fails if a register has two shifts open (on two drawers): close one first
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_shift_register_active" ON "shifts" ("tenantId", "registerId") WHERE "status" IN ('open', 'closing')`,
    );
    await queryRunner.query(
      `ALTER TABLE "shifts" DROP CONSTRAINT "FK_shifts_drawer"`,
    );
    await queryRunner.query(`ALTER TABLE "shifts"
      DROP COLUMN "handedOverToId", DROP COLUMN "previousShiftId",
      DROP COLUMN "businessDate", DROP COLUMN "shared", DROP COLUMN "drawerId"`);

    await queryRunner.query(`DROP FUNCTION IF EXISTS pos_store_cutoff(uuid)`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS pos_business_date(timestamptz, text, integer)`,
    );

    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_registers_main_drawer" ON "registers"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS pos_register_main_drawer()`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" DROP CONSTRAINT "CHK_registers_drawer_policy"`,
    );
    await queryRunner.query(
      `ALTER TABLE "registers" DROP COLUMN "drawerPolicy"`,
    );
    await queryRunner.query(`ALTER TABLE "registers" ADD "drawerId" uuid`);
    await queryRunner.query(
      `UPDATE "registers" r SET "drawerId" = d."id" FROM "drawers" d
       WHERE d."registerId" = r."id" AND d."code" = 'MAIN'`,
    );
    await queryRunner.query(`DROP TABLE "drawers"`);

    await queryRunner.query(`DROP TABLE "employee_attendance"`);
    await queryRunner.query(`DROP TABLE "employee_branches"`);
    await queryRunner.query(`DROP TABLE "employees"`);

    // Cash movements typed sale / no_sale are ledger-only; drop them so the enum
    // values are unused (Postgres cannot remove enum values: they stay defined)
    await queryRunner.query(
      `DELETE FROM "cash_movements" WHERE "type"::text IN ('sale', 'no_sale')`,
    );
  }
}
