import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer credit and stored value wave (D019, spec §11/§12):
 *
 * - Customer account ledger: customer_credit_entries (append-only, trigger;
 *   the only UPDATE allowed re-points "customerId" when customers are merged)
 *   and customer_credit_allocations (FIFO settlement of charges, for aging).
 *   customers.currentBalance stays as the projection of the ledger. Balances
 *   that exist already get an opening_balance entry so ledger = projection.
 * - customers.paymentTermDays / creditHold, customer_groups.defaultPaymentTermDays.
 * - Gift cards and store credit: stored_value_accounts (code hash + last 4,
 *   balance >= 0) and stored_value_entries (append-only, trigger).
 * - Payment method types gift_card and on_account (methods are created lazily).
 * - Returns: returnType (return / goodwill / exchange), disposition 'damaged'
 *   (kept, at the damaged / quarantine location), exchange_links.
 * - Customer addresses, contacts and internal notes.
 * - Permissions customers.credit.sell / .override / .receive / .manage and
 *   sales.refund.goodwill for the built-in owner, admin and manager roles;
 *   customers.credit.receive also for cashiers (taking a payment at the till).
 *
 * Cash taken for a customer payment is a cash_movements row of type paid_in
 * with sourceType 'customer_payment' (no new enum value).
 */
export class CustomerCreditStoredValue1790500000000 implements MigrationInterface {
  name = 'CustomerCreditStoredValue1790500000000';

  private readonly managerPermissions = [
    'customers.credit.sell',
    'customers.credit.override',
    'customers.credit.receive',
    'customers.credit.manage',
    'sales.refund.goodwill',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- Enum values ----
    for (const value of ['gift_card', 'on_account']) {
      await queryRunner.query(
        `ALTER TYPE "public"."payment_methods_methodtype_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
    await queryRunner.query(
      `ALTER TYPE "public"."sale_return_items_disposition_enum" ADD VALUE IF NOT EXISTS 'damaged'`,
    );

    // ---- Customers ----
    await queryRunner.query(`ALTER TABLE "customers"
      ADD "paymentTermDays" integer,
      ADD "creditHold" boolean NOT NULL DEFAULT false`);
    await queryRunner.query(
      `ALTER TABLE "customer_groups" ADD "defaultPaymentTermDays" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" ADD CONSTRAINT "CHK_customers_payment_terms" CHECK ("paymentTermDays" IS NULL OR "paymentTermDays" BETWEEN 0 AND 3650)`,
    );

    // ---- Customer account ledger ----
    await queryRunner.query(
      `CREATE TYPE "public"."customer_credit_entries_type_enum" AS ENUM('charge', 'payment', 'credit_note', 'adjustment', 'opening_balance', 'reversal')`,
    );
    await queryRunner.query(`CREATE TABLE "customer_credit_entries" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "tenantId" uuid NOT NULL,
      "customerId" uuid NOT NULL,
      "type" "public"."customer_credit_entries_type_enum" NOT NULL,
      "amount" numeric(19,4) NOT NULL,
      "balanceAfter" numeric(19,4) NOT NULL,
      "saleId" uuid,
      "returnId" uuid,
      "paymentMethodId" uuid,
      "paymentRef" character varying(255),
      "dueDate" date,
      "reversalOfId" uuid,
      "createdById" uuid,
      "approverId" uuid,
      "note" character varying(500),
      "idempotencyKey" character varying(100),
      CONSTRAINT "PK_customer_credit_entries" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_credit_entries_amount" CHECK ("amount" <> 0)
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_credit_entries_customer" ON "customer_credit_entries" ("tenantId", "customerId", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_credit_entries_sale" ON "customer_credit_entries" ("tenantId", "saleId") WHERE "saleId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_credit_entry_idempotency" ON "customer_credit_entries" ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_credit_entries" ADD CONSTRAINT "FK_credit_entries_customer" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    await queryRunner.query(`CREATE TABLE "customer_credit_allocations" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "tenantId" uuid NOT NULL,
      "customerId" uuid NOT NULL,
      "debitEntryId" uuid NOT NULL,
      "creditEntryId" uuid NOT NULL,
      "amount" numeric(19,4) NOT NULL,
      CONSTRAINT "PK_customer_credit_allocations" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_credit_alloc_amount" CHECK ("amount" > 0)
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_credit_alloc_debit" ON "customer_credit_allocations" ("debitEntryId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_credit_alloc_credit" ON "customer_credit_allocations" ("creditEntryId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_credit_alloc_customer" ON "customer_credit_allocations" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_credit_allocations" ADD CONSTRAINT "FK_credit_alloc_debit" FOREIGN KEY ("debitEntryId") REFERENCES "customer_credit_entries"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_credit_allocations" ADD CONSTRAINT "FK_credit_alloc_credit" FOREIGN KEY ("creditEntryId") REFERENCES "customer_credit_entries"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // Existing balances become the opening balance of the ledger (due today)
    await queryRunner.query(`
      INSERT INTO "customer_credit_entries"
        ("tenantId", "customerId", "type", "amount", "balanceAfter", "dueDate", "note")
      SELECT "tenantId", id, 'opening_balance', "currentBalance", "currentBalance", CURRENT_DATE,
             'Balance before the customer account ledger'
        FROM "customers" WHERE "currentBalance" <> 0`);

    // ---- Gift cards and store credit ----
    await queryRunner.query(
      `CREATE TYPE "public"."stored_value_accounts_type_enum" AS ENUM('gift_card', 'store_credit')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stored_value_accounts_status_enum" AS ENUM('pending', 'active', 'void')`,
    );
    await queryRunner.query(`CREATE TABLE "stored_value_accounts" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "version" integer NOT NULL DEFAULT 1,
      "tenantId" uuid NOT NULL,
      "accountType" "public"."stored_value_accounts_type_enum" NOT NULL,
      "codeHash" character varying(64),
      "last4" character varying(4),
      "customerId" uuid,
      "balance" numeric(19,4) NOT NULL DEFAULT '0',
      "initialAmount" numeric(19,4) NOT NULL DEFAULT '0',
      "currencyCode" character(3) NOT NULL,
      "status" "public"."stored_value_accounts_status_enum" NOT NULL DEFAULT 'active',
      "expiresAt" TIMESTAMP WITH TIME ZONE,
      "saleId" uuid,
      "saleItemId" uuid,
      "createdById" uuid,
      "metadata" jsonb NOT NULL DEFAULT '{}',
      CONSTRAINT "PK_stored_value_accounts" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_stored_value_balance" CHECK ("balance" >= 0),
      CONSTRAINT "CHK_stored_value_owner" CHECK (
        ("accountType" = 'gift_card' AND "codeHash" IS NOT NULL)
        OR ("accountType" = 'store_credit' AND "customerId" IS NOT NULL))
    )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_stored_value_code" ON "stored_value_accounts" ("tenantId", "codeHash") WHERE "codeHash" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_store_credit_customer" ON "stored_value_accounts" ("tenantId", "customerId") WHERE "accountType" = 'store_credit' AND "status" <> 'void'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stored_value_customer" ON "stored_value_accounts" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stored_value_sale" ON "stored_value_accounts" ("tenantId", "saleId") WHERE "saleId" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "stored_value_accounts" ADD CONSTRAINT "FK_stored_value_customer" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."stored_value_entries_type_enum" AS ENUM('issue', 'redeem', 'refund_credit', 'reversal', 'adjustment', 'expire')`,
    );
    await queryRunner.query(`CREATE TABLE "stored_value_entries" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "tenantId" uuid NOT NULL,
      "accountId" uuid NOT NULL,
      "type" "public"."stored_value_entries_type_enum" NOT NULL,
      "amount" numeric(19,4) NOT NULL,
      "balanceAfter" numeric(19,4) NOT NULL,
      "saleId" uuid,
      "paymentId" uuid,
      "returnId" uuid,
      "createdById" uuid,
      "note" character varying(500),
      CONSTRAINT "PK_stored_value_entries" PRIMARY KEY ("id"),
      CONSTRAINT "CHK_stored_value_entries_amount" CHECK ("amount" <> 0)
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_stored_value_entries_account" ON "stored_value_entries" ("accountId", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_stored_value_entries_sale" ON "stored_value_entries" ("tenantId", "saleId") WHERE "saleId" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "stored_value_entries" ADD CONSTRAINT "FK_stored_value_entries_account" FOREIGN KEY ("accountId") REFERENCES "stored_value_accounts"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    // ---- Returns: goodwill / exchange, damaged goods kept ----
    await queryRunner.query(
      `CREATE TYPE "public"."sale_returns_returntype_enum" AS ENUM('return', 'goodwill', 'exchange')`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_returns" ADD "returnType" "public"."sale_returns_returntype_enum" NOT NULL DEFAULT 'return'`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."exchange_links_status_enum" AS ENUM('pending', 'completed', 'incomplete')`,
    );
    await queryRunner.query(`CREATE TABLE "exchange_links" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "tenantId" uuid NOT NULL,
      "originalSaleId" uuid NOT NULL,
      "returnId" uuid NOT NULL,
      "newSaleId" uuid,
      "status" "public"."exchange_links_status_enum" NOT NULL DEFAULT 'pending',
      "returnTotal" numeric(19,4) NOT NULL,
      "creditAmount" numeric(19,4) NOT NULL,
      "newSaleTotal" numeric(19,4) NOT NULL,
      "difference" numeric(19,4) NOT NULL,
      "failureReason" character varying(500),
      "createdById" uuid,
      CONSTRAINT "PK_exchange_links" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_exchange_return" ON "exchange_links" ("returnId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_exchange_new_sale" ON "exchange_links" ("newSaleId") WHERE "newSaleId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_exchange_tenant_status" ON "exchange_links" ("tenantId", "status")`,
    );
    await queryRunner.query(
      `ALTER TABLE "exchange_links" ADD CONSTRAINT "FK_exchange_links_return" FOREIGN KEY ("returnId") REFERENCES "sale_returns"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    // ---- Customer addresses, contacts, notes ----
    await queryRunner.query(
      `CREATE TYPE "public"."customer_addresses_type_enum" AS ENUM('billing', 'shipping')`,
    );
    await queryRunner.query(`CREATE TABLE "customer_addresses" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "tenantId" uuid NOT NULL,
      "customerId" uuid NOT NULL,
      "addressType" "public"."customer_addresses_type_enum" NOT NULL,
      "label" character varying(100),
      "line1" character varying(255) NOT NULL,
      "line2" character varying(255),
      "city" character varying(100),
      "state" character varying(100),
      "postalCode" character varying(20),
      "country" character varying(100),
      "isDefault" boolean NOT NULL DEFAULT false,
      CONSTRAINT "PK_customer_addresses" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_addresses_customer" ON "customer_addresses" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_customer_address_default" ON "customer_addresses" ("tenantId", "customerId", "addressType") WHERE "isDefault" = true`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_addresses" ADD CONSTRAINT "FK_customer_addresses_customer" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await queryRunner.query(`CREATE TABLE "customer_contacts" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "tenantId" uuid NOT NULL,
      "customerId" uuid NOT NULL,
      "name" character varying(255) NOT NULL,
      "role" character varying(100),
      "email" character varying(255),
      "phone" character varying(50),
      "isPrimary" boolean NOT NULL DEFAULT false,
      CONSTRAINT "PK_customer_contacts" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_contacts_customer" ON "customer_contacts" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_contacts" ADD CONSTRAINT "FK_customer_contacts_customer" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    await queryRunner.query(
      `CREATE TYPE "public"."customer_notes_visibility_enum" AS ENUM('all', 'managers')`,
    );
    await queryRunner.query(`CREATE TABLE "customer_notes" (
      "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
      "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      "tenantId" uuid NOT NULL,
      "customerId" uuid NOT NULL,
      "body" text NOT NULL,
      "visibility" "public"."customer_notes_visibility_enum" NOT NULL DEFAULT 'all',
      "createdById" uuid,
      CONSTRAINT "PK_customer_notes" PRIMARY KEY ("id")
    )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_notes_customer" ON "customer_notes" ("tenantId", "customerId", "created_at")`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_notes" ADD CONSTRAINT "FK_customer_notes_customer" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // ---- Permissions ----
    for (const key of this.managerPermissions) {
      await queryRunner.query(
        `UPDATE "tenant_roles" SET "permissions" = "permissions" || jsonb_build_array($1::text)
         WHERE "isSystem" = true AND "key" IN ('owner', 'admin', 'manager') AND NOT "permissions" ? $1`,
        [key],
      );
    }
    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" || jsonb_build_array($1::text)
       WHERE "isSystem" = true AND "key" = 'cashier' AND NOT "permissions" ? $1`,
      ['customers.credit.receive'],
    );

    // ---- Append-only ledgers (last: the opening balances above are inserts) ----
    // DELETE only with app.audit_purge (whole test tenant removal, as for the audit
    // log); customer ledger rows may only have "customerId" re-pointed (merge).
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION customer_credit_entries_append_only() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        IF TG_OP = 'UPDATE'
           AND (to_jsonb(NEW) - 'customerId') = (to_jsonb(OLD) - 'customerId') THEN
          RETURN NEW;
        END IF;
        RAISE EXCEPTION 'customer_credit_entries is append-only: post an adjustment or reversal instead';
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(`
      CREATE TRIGGER "trg_customer_credit_entries_append_only"
      BEFORE UPDATE OR DELETE ON "customer_credit_entries"
      FOR EACH ROW EXECUTE FUNCTION customer_credit_entries_append_only()`);
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION stored_value_entries_append_only() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'stored_value_entries is append-only: post an adjustment or reversal instead';
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(`
      CREATE TRIGGER "trg_stored_value_entries_append_only"
      BEFORE UPDATE OR DELETE ON "stored_value_entries"
      FOR EACH ROW EXECUTE FUNCTION stored_value_entries_append_only()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_stored_value_entries_append_only" ON "stored_value_entries"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS stored_value_entries_append_only()`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_customer_credit_entries_append_only" ON "customer_credit_entries"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS customer_credit_entries_append_only()`,
    );
    for (const key of this.managerPermissions) {
      await queryRunner.query(
        `UPDATE "tenant_roles" SET "permissions" = "permissions" - $1::text WHERE "permissions" ? $1`,
        [key],
      );
    }
    await queryRunner.query(`DROP TABLE "customer_notes"`);
    await queryRunner.query(
      `DROP TYPE "public"."customer_notes_visibility_enum"`,
    );
    await queryRunner.query(`DROP TABLE "customer_contacts"`);
    await queryRunner.query(`DROP TABLE "customer_addresses"`);
    await queryRunner.query(
      `DROP TYPE "public"."customer_addresses_type_enum"`,
    );
    await queryRunner.query(`DROP TABLE "exchange_links"`);
    await queryRunner.query(`DROP TYPE "public"."exchange_links_status_enum"`);
    await queryRunner.query(
      `ALTER TABLE "sale_returns" DROP COLUMN "returnType"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."sale_returns_returntype_enum"`,
    );
    await queryRunner.query(`DROP TABLE "stored_value_entries"`);
    await queryRunner.query(
      `DROP TYPE "public"."stored_value_entries_type_enum"`,
    );
    await queryRunner.query(`DROP TABLE "stored_value_accounts"`);
    await queryRunner.query(
      `DROP TYPE "public"."stored_value_accounts_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."stored_value_accounts_type_enum"`,
    );
    await queryRunner.query(`DROP TABLE "customer_credit_allocations"`);
    await queryRunner.query(`DROP TABLE "customer_credit_entries"`);
    await queryRunner.query(
      `DROP TYPE "public"."customer_credit_entries_type_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" DROP CONSTRAINT "CHK_customers_payment_terms"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_groups" DROP COLUMN "defaultPaymentTermDays"`,
    );
    await queryRunner.query(`ALTER TABLE "customers"
      DROP COLUMN "creditHold",
      DROP COLUMN "paymentTermDays"`);
    // Values added to payment_methods_methodtype_enum and
    // sale_return_items_disposition_enum stay (Postgres cannot drop enum values)
  }
}
