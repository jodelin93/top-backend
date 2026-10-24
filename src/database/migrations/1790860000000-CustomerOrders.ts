import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Orders with a deposit (services not tracked in stock): customer_orders, their
 * lines, and the append-only ledger of deposits / refunds (cash deposits go into
 * the session's drawer as paid-ins). New permissions: orders.manage (take
 * orders and deposits, mark them ready) for the roles that sell at the till,
 * and orders.cancel (cancel an order, refund or keep its deposits) for the
 * built-in owner, admin and manager roles.
 */
export class CustomerOrders1790860000000 implements MigrationInterface {
  name = 'CustomerOrders1790860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."customer_orders_status_enum" AS ENUM('open', 'ready', 'picked_up', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "customer_orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL DEFAULT '1', "tenantId" uuid NOT NULL, "orderNumber" character varying(50) NOT NULL, "branchId" uuid NOT NULL, "registerId" uuid NOT NULL, "customerId" uuid NOT NULL, "userId" uuid NOT NULL, "status" "public"."customer_orders_status_enum" NOT NULL DEFAULT 'open', "readyBy" date, "subtotal" numeric(19,4) NOT NULL, "discountAmount" numeric(19,4) NOT NULL, "taxAmount" numeric(19,4) NOT NULL, "total" numeric(19,4) NOT NULL, "paidAmount" numeric(19,4) NOT NULL DEFAULT '0', "currencyCode" character(3) NOT NULL, "cartDiscount" jsonb, "groupDiscountPercent" numeric(5,2) NOT NULL DEFAULT '0', "notes" character varying(1000), "readyAt" TIMESTAMP WITH TIME ZONE, "readyById" uuid, "saleId" uuid, "pickedUpAt" TIMESTAMP WITH TIME ZONE, "cancelledAt" TIMESTAMP WITH TIME ZONE, "cancelledById" uuid, "cancelApproverId" uuid, "cancelReason" character varying(500), "depositOutcome" character varying(20), "idempotencyKey" character varying(100), CONSTRAINT "uq_customer_order_number" UNIQUE ("tenantId", "orderNumber"), CONSTRAINT "CHK_customer_orders_paid" CHECK ("paidAmount" >= 0), CONSTRAINT "PK_ce425b6edb31cce9a80b269298e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_customer_order_idempotency" ON "customer_orders" ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_orders_sale" ON "customer_orders" ("tenantId", "saleId") WHERE "saleId" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_orders_customer" ON "customer_orders" ("tenantId", "customerId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_orders_tenant_status" ON "customer_orders" ("tenantId", "status", "created_at")`,
    );
    await queryRunner.query(
      `CREATE TABLE "customer_order_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "orderId" uuid NOT NULL, "variantId" uuid NOT NULL, "sku" character varying(100) NOT NULL, "productName" character varying(255) NOT NULL, "variantName" character varying(255), "quantity" numeric(19,4) NOT NULL, "unitPrice" numeric(19,4) NOT NULL, "catalogPrice" numeric(19,4) NOT NULL, "discountPercent" numeric(5,2) NOT NULL DEFAULT '0', "subtotal" numeric(19,4) NOT NULL, "discountAmount" numeric(19,4) NOT NULL, "taxRate" numeric(5,2), "taxAmount" numeric(19,4) NOT NULL, "total" numeric(19,4) NOT NULL, "note" character varying(255), "lineNumber" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_109f14f4feec8f45a57e39c4660" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_order_items_order" ON "customer_order_items" ("orderId")`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."customer_order_payments_type_enum" AS ENUM('deposit', 'refund')`,
    );
    await queryRunner.query(
      `CREATE TABLE "customer_order_payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "orderId" uuid NOT NULL, "type" "public"."customer_order_payments_type_enum" NOT NULL, "amount" numeric(19,4) NOT NULL, "paymentMethodId" uuid NOT NULL, "reference" character varying(255), "tenderedCurrency" character(3), "tenderedAmount" numeric(19,4), "exchangeRate" numeric(19,8), "shiftId" uuid, "registerId" uuid, "userId" uuid NOT NULL, "approverId" uuid, "note" character varying(500), "idempotencyKey" character varying(100), CONSTRAINT "CHK_customer_order_payments_amount" CHECK ("amount" > 0), CONSTRAINT "PK_customer_order_payments" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_customer_order_payment_idempotency" ON "customer_order_payments" ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_order_payments_date" ON "customer_order_payments" ("tenantId", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_order_payments_order" ON "customer_order_payments" ("tenantId", "orderId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_orders" ADD CONSTRAINT "FK_customer_orders_customer" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_order_items" ADD CONSTRAINT "FK_customer_order_items_order" FOREIGN KEY ("orderId") REFERENCES "customer_orders"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_order_payments" ADD CONSTRAINT "FK_customer_order_payments_order" FOREIGN KEY ("orderId") REFERENCES "customer_orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_order_payments" ADD CONSTRAINT "FK_customer_order_payments_method" FOREIGN KEY ("paymentMethodId") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );

    // Deposits and refunds are money records: never changed or deleted (DELETE
    // only with app.audit_purge, whole test tenant removal), never truncated
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION customer_order_payments_append_only() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' AND current_setting('app.audit_purge', true) = 'on' THEN
          RETURN OLD;
        END IF;
        RAISE EXCEPTION 'customer_order_payments is append-only: record a refund instead';
      END;
      $$ LANGUAGE plpgsql`);
    await queryRunner.query(`
      CREATE TRIGGER "trg_customer_order_payments_append_only"
      BEFORE UPDATE OR DELETE ON "customer_order_payments"
      FOR EACH ROW EXECUTE FUNCTION customer_order_payments_append_only()`);
    await queryRunner.query(`
      CREATE TRIGGER "trg_customer_order_payments_no_truncate"
      BEFORE TRUNCATE ON "customer_order_payments"
      FOR EACH STATEMENT EXECUTE FUNCTION append_only_no_truncate()`);

    // Taking orders: every role that sells at the till. Cancelling: owner, admin, manager.
    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" || jsonb_build_array('orders.manage'::text)
        WHERE NOT "permissions" ? 'orders.manage'
          AND (("isSystem" = true AND "key" IN ('owner', 'admin', 'manager', 'cashier'))
            OR ("isSystem" = false AND "permissions" ? 'pos.sell'))`,
    );
    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" || jsonb_build_array('orders.cancel'::text)
        WHERE NOT "permissions" ? 'orders.cancel'
          AND "isSystem" = true AND "key" IN ('owner', 'admin', 'manager')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" - 'orders.manage'::text - 'orders.cancel'::text
        WHERE "permissions" ?| ARRAY['orders.manage', 'orders.cancel']`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_customer_order_payments_no_truncate" ON "customer_order_payments"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "trg_customer_order_payments_append_only" ON "customer_order_payments"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS customer_order_payments_append_only()`,
    );
    await queryRunner.query(`DROP TABLE "customer_order_payments"`);
    await queryRunner.query(
      `DROP TYPE "public"."customer_order_payments_type_enum"`,
    );
    await queryRunner.query(`DROP TABLE "customer_order_items"`);
    await queryRunner.query(`DROP TABLE "customer_orders"`);
    await queryRunner.query(`DROP TYPE "public"."customer_orders_status_enum"`);
  }
}
