import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Register shifts, the cash drawer ledger, custom cash denominations,
 * expense categories and expenses (docs/features/shifts-expenses.md).
 */
export class ShiftsAndExpenses1790303000000 implements MigrationInterface {
  name = 'ShiftsAndExpenses1790303000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "cash_denomination_sets" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "currencyCode" character(3) NOT NULL, "denominations" jsonb NOT NULL, CONSTRAINT "uq_cash_denomination_set" UNIQUE ("tenantId", "currencyCode"), CONSTRAINT "PK_524b1e71737c7126d8deb1bb6a3" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."shifts_status_enum" AS ENUM('open', 'closing', 'closed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "shifts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL DEFAULT '1', "tenantId" uuid NOT NULL, "shiftNumber" character varying(50) NOT NULL, "registerId" uuid NOT NULL, "branchId" uuid, "status" "public"."shifts_status_enum" NOT NULL DEFAULT 'open', "currencyCode" character(3) NOT NULL, "openedById" uuid NOT NULL, "openedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "openingFloat" numeric(19,4) NOT NULL, "openingDenominations" jsonb, "openingNotes" character varying(500), "blindCount" boolean NOT NULL DEFAULT false, "closingStartedAt" TIMESTAMP WITH TIME ZONE, "closedById" uuid, "closeApprovedById" uuid, "closedAt" TIMESTAMP WITH TIME ZONE, "closingDenominations" jsonb, "countedCash" numeric(19,4), "expectedCash" numeric(19,4), "variance" numeric(19,4), "varianceReason" character varying(500), "closingNotes" character varying(500), "forceClosed" boolean NOT NULL DEFAULT false, "closeIdempotencyKey" character varying(100), "closingSummary" jsonb, CONSTRAINT "uq_shift_id_tenant" UNIQUE ("id", "tenantId"), CONSTRAINT "uq_shift_number" UNIQUE ("tenantId", "shiftNumber"), CONSTRAINT "PK_84d692e367e4d6cdf045828768c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_shift_close_idempotency" ON "shifts"  ("tenantId", "closeIdempotencyKey") WHERE "closeIdempotencyKey" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_shift_register_active" ON "shifts"  ("tenantId", "registerId") WHERE "status" IN ('open', 'closing')`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_shifts_register" ON "shifts"  ("registerId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_shifts_tenant_status" ON "shifts"  ("tenantId", "status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_shifts_tenant_opened" ON "shifts"  ("tenantId", "openedAt") `,
    );
    await queryRunner.query(
      `CREATE TABLE "expense_categories" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" character varying(255) NOT NULL, "description" character varying(500), "isActive" boolean NOT NULL DEFAULT true, CONSTRAINT "uq_expense_category_id_tenant" UNIQUE ("id", "tenantId"), CONSTRAINT "uq_expense_category_code" UNIQUE ("tenantId", "code"), CONSTRAINT "PK_d0ef31e189d9523461215b62775" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_expense_categories_tenant" ON "expense_categories"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."expenses_paymentmethod_enum" AS ENUM('cash', 'card', 'bank', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."expenses_status_enum" AS ENUM('draft', 'submitted', 'approved', 'rejected', 'paid')`,
    );
    await queryRunner.query(
      `CREATE TABLE "expenses" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL DEFAULT '1', "tenantId" uuid NOT NULL, "expenseNumber" character varying(50) NOT NULL, "expenseDate" date NOT NULL, "categoryId" uuid, "amount" numeric(19,4) NOT NULL, "currencyCode" character(3) NOT NULL, "description" character varying(500) NOT NULL, "payee" character varying(255), "receiptReference" character varying(255), "paymentMethod" "public"."expenses_paymentmethod_enum" NOT NULL DEFAULT 'cash', "registerId" uuid, "shiftId" uuid, "status" "public"."expenses_status_enum" NOT NULL DEFAULT 'draft', "approvalRequired" boolean NOT NULL DEFAULT false, "createdById" uuid NOT NULL, "submittedAt" TIMESTAMP WITH TIME ZONE, "submittedById" uuid, "approvedById" uuid, "approvedAt" TIMESTAMP WITH TIME ZONE, "rejectedById" uuid, "rejectedAt" TIMESTAMP WITH TIME ZONE, "rejectionReason" character varying(500), "paidById" uuid, "paidAt" TIMESTAMP WITH TIME ZONE, "notes" character varying(1000), CONSTRAINT "uq_expense_id_tenant" UNIQUE ("id", "tenantId"), CONSTRAINT "uq_expense_number" UNIQUE ("tenantId", "expenseNumber"), CONSTRAINT "PK_94c3ceb17e3140abc9282c20610" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_expenses_shift" ON "expenses"  ("shiftId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_expenses_tenant_status" ON "expenses"  ("tenantId", "status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_expenses_tenant_date" ON "expenses"  ("tenantId", "expenseDate") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."cash_movements_type_enum" AS ENUM('opening_float', 'paid_in', 'paid_out', 'safe_drop', 'expense', 'refund')`,
    );
    await queryRunner.query(
      `CREATE TABLE "cash_movements" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "shiftId" uuid NOT NULL, "registerId" uuid NOT NULL, "type" "public"."cash_movements_type_enum" NOT NULL, "amount" numeric(19,4) NOT NULL, "reason" character varying(500), "reference" character varying(255), "expenseId" uuid, "sourceType" character varying(50), "sourceId" uuid, "idempotencyKey" character varying(100), "userId" uuid NOT NULL, "approverId" uuid, CONSTRAINT "PK_25faead19e1ff74153a01604d37" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_cash_movement_source" ON "cash_movements"  ("tenantId", "sourceType", "sourceId") WHERE "sourceId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_cash_movement_idempotency" ON "cash_movements"  ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_cash_movement_expense" ON "cash_movements"  ("expenseId") WHERE "expenseId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cash_movements_shift" ON "cash_movements"  ("tenantId", "shiftId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_denomination_sets" ADD CONSTRAINT "FK_cash_denomination_sets_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "shifts" ADD CONSTRAINT "FK_shifts_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "shifts" ADD CONSTRAINT "FK_shifts_register" FOREIGN KEY ("registerId") REFERENCES "registers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "shifts" ADD CONSTRAINT "FK_shifts_opened_by" FOREIGN KEY ("openedById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "shifts" ADD CONSTRAINT "FK_shifts_closed_by" FOREIGN KEY ("closedById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "expense_categories" ADD CONSTRAINT "FK_expense_categories_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "expenses" ADD CONSTRAINT "FK_expenses_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "expenses" ADD CONSTRAINT "FK_expenses_category" FOREIGN KEY ("categoryId", "tenantId") REFERENCES "expense_categories"("id","tenantId") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "expenses" ADD CONSTRAINT "FK_expenses_created_by" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movements" ADD CONSTRAINT "FK_cash_movements_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movements" ADD CONSTRAINT "FK_cash_movements_shift" FOREIGN KEY ("shiftId", "tenantId") REFERENCES "shifts"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movements" ADD CONSTRAINT "FK_cash_movements_expense" FOREIGN KEY ("expenseId") REFERENCES "expenses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movements" ADD CONSTRAINT "FK_cash_movements_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cash_movements" DROP CONSTRAINT "FK_cash_movements_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movements" DROP CONSTRAINT "FK_cash_movements_expense"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movements" DROP CONSTRAINT "FK_cash_movements_shift"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_movements" DROP CONSTRAINT "FK_cash_movements_tenant"`,
    );
    await queryRunner.query(
      `ALTER TABLE "expenses" DROP CONSTRAINT "FK_expenses_created_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "expenses" DROP CONSTRAINT "FK_expenses_category"`,
    );
    await queryRunner.query(
      `ALTER TABLE "expenses" DROP CONSTRAINT "FK_expenses_tenant"`,
    );
    await queryRunner.query(
      `ALTER TABLE "expense_categories" DROP CONSTRAINT "FK_expense_categories_tenant"`,
    );
    await queryRunner.query(
      `ALTER TABLE "shifts" DROP CONSTRAINT "FK_shifts_closed_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "shifts" DROP CONSTRAINT "FK_shifts_opened_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "shifts" DROP CONSTRAINT "FK_shifts_register"`,
    );
    await queryRunner.query(
      `ALTER TABLE "shifts" DROP CONSTRAINT "FK_shifts_tenant"`,
    );
    await queryRunner.query(
      `ALTER TABLE "cash_denomination_sets" DROP CONSTRAINT "FK_cash_denomination_sets_tenant"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_cash_movements_shift"`);
    await queryRunner.query(`DROP INDEX "public"."uq_cash_movement_expense"`);
    await queryRunner.query(
      `DROP INDEX "public"."uq_cash_movement_idempotency"`,
    );
    await queryRunner.query(`DROP INDEX "public"."uq_cash_movement_source"`);
    await queryRunner.query(`DROP TABLE "cash_movements"`);
    await queryRunner.query(`DROP TYPE "public"."cash_movements_type_enum"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_expenses_tenant_date"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_expenses_tenant_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_expenses_shift"`);
    await queryRunner.query(`DROP TABLE "expenses"`);
    await queryRunner.query(`DROP TYPE "public"."expenses_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."expenses_paymentmethod_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_expense_categories_tenant"`,
    );
    await queryRunner.query(`DROP TABLE "expense_categories"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_shifts_tenant_opened"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_shifts_tenant_status"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_shifts_register"`);
    await queryRunner.query(`DROP INDEX "public"."uq_shift_register_active"`);
    await queryRunner.query(`DROP INDEX "public"."uq_shift_close_idempotency"`);
    await queryRunner.query(`DROP TABLE "shifts"`);
    await queryRunner.query(`DROP TYPE "public"."shifts_status_enum"`);
    await queryRunner.query(`DROP TABLE "cash_denomination_sets"`);
  }
}
