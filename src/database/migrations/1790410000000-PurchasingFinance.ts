import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Purchasing finance (spec §10):
 * - suppliers: lead time; supplier_products (supplier code, last cost, minimum
 *   order quantity, preferred supplier per variant)
 * - purchase orders: 'closed' status (short-close), supplier reference,
 *   revisions after approval, line discount %, line tax, unit of measure
 * - goods receipts: unplanned receipts (no PO), condition per line
 *   (good / damaged, accepted or not), over-receipt approver
 * - supplier returns, supplier invoices (3-way match), credits, payments and
 *   their allocations to invoices
 * - permissions purchasing.receive.unplanned and purchasing.payables for the
 *   owner, admin and manager roles
 */
export class PurchasingFinance1790410000000 implements MigrationInterface {
  name = 'PurchasingFinance1790410000000';

  private readonly permissions = [
    'purchasing.receive.unplanned',
    'purchasing.payables',
  ];

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- Suppliers ----
    await queryRunner.query(
      `ALTER TABLE "suppliers" ADD "leadTimeDays" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "suppliers" ADD CONSTRAINT "chk_suppliers_lead_time" CHECK ("leadTimeDays" IS NULL OR "leadTimeDays" >= 0)`,
    );
    await queryRunner.query(
      `ALTER TABLE "suppliers" ADD CONSTRAINT "uq_suppliers_id_tenant" UNIQUE ("id", "tenantId")`,
    );
    await queryRunner.query(`
      CREATE TABLE "supplier_products" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "supplierId" uuid NOT NULL,
        "variantId" uuid NOT NULL,
        "supplierSku" character varying(100),
        "lastCost" numeric(19,4),
        "minOrderQty" integer,
        "isPreferred" boolean NOT NULL DEFAULT false,
        CONSTRAINT "uq_supplier_products_variant" UNIQUE ("tenantId", "supplierId", "variantId"),
        CONSTRAINT "chk_supplier_products_values" CHECK (("lastCost" IS NULL OR "lastCost" >= 0) AND ("minOrderQty" IS NULL OR "minOrderQty" >= 1)),
        CONSTRAINT "PK_supplier_products" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_products_variant" ON "supplier_products" ("tenantId", "variantId")`,
    );
    // At most one preferred supplier per variant
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_supplier_products_preferred" ON "supplier_products" ("tenantId", "variantId") WHERE "isPreferred"`,
    );

    // ---- Purchase orders ----
    // Not used in this transaction, so it can be added inside it (PG 12+)
    await queryRunner.query(
      `ALTER TYPE "public"."purchase_orders_status_enum" ADD VALUE IF NOT EXISTS 'closed' BEFORE 'cancelled'`,
    );
    await queryRunner.query(`
      ALTER TABLE "purchase_orders"
        ADD "discountAmount" numeric(19,4) NOT NULL DEFAULT '0',
        ADD "supplierReference" character varying(100),
        ADD "closedAt" TIMESTAMP WITH TIME ZONE,
        ADD "closeReason" character varying(500),
        ADD "revisionNumber" integer NOT NULL DEFAULT 0,
        ADD "revisedById" uuid`);
    await queryRunner.query(`
      ALTER TABLE "purchase_order_items"
        ADD "quantityCancelled" integer NOT NULL DEFAULT 0,
        ADD "discountPercent" numeric(7,4) NOT NULL DEFAULT '0',
        ADD "discountAmount" numeric(19,4) NOT NULL DEFAULT '0',
        ADD "unitOfMeasure" character varying(30),
        ADD "supplierSku" character varying(100),
        ADD CONSTRAINT "chk_purchase_order_items_quantities" CHECK ("quantityCancelled" >= 0 AND "quantityReceived" >= 0),
        ADD CONSTRAINT "chk_purchase_order_items_discount" CHECK ("discountPercent" >= 0 AND "discountPercent" <= 100)`);
    await queryRunner.query(`
      CREATE TABLE "purchase_order_revisions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "purchaseOrderId" uuid NOT NULL,
        "revisionNumber" integer NOT NULL,
        "userId" uuid NOT NULL,
        "reason" character varying(500),
        "statusBefore" character varying(30) NOT NULL,
        "statusAfter" character varying(30) NOT NULL,
        "totalBefore" numeric(19,4) NOT NULL,
        "totalAfter" numeric(19,4) NOT NULL,
        "requiresApproval" boolean NOT NULL DEFAULT false,
        "before" jsonb NOT NULL,
        "after" jsonb NOT NULL,
        "rejectedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "uq_purchase_order_revisions_number" UNIQUE ("purchaseOrderId", "revisionNumber"),
        CONSTRAINT "PK_purchase_order_revisions" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_purchase_order_revisions_tenant" ON "purchase_order_revisions" ("tenantId")`,
    );

    // ---- Goods receipts ----
    await queryRunner.query(`
      ALTER TABLE "goods_receipts"
        ALTER COLUMN "purchaseOrderId" DROP NOT NULL,
        ADD "supplierId" uuid,
        ADD "overReceiptApprovedById" uuid`);
    await queryRunner.query(`
      UPDATE "goods_receipts" gr SET "supplierId" = po."supplierId"
      FROM "purchase_orders" po
      WHERE po."id" = gr."purchaseOrderId" AND po."tenantId" = gr."tenantId"`);
    await queryRunner.query(
      `ALTER TABLE "goods_receipts" ALTER COLUMN "supplierId" SET NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_goods_receipts_supplier" ON "goods_receipts" ("tenantId", "supplierId")`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."goods_receipt_items_condition_enum" AS ENUM('good', 'damaged')`,
    );
    await queryRunner.query(`
      ALTER TABLE "goods_receipt_items"
        ALTER COLUMN "purchaseOrderItemId" DROP NOT NULL,
        ADD "condition" "public"."goods_receipt_items_condition_enum" NOT NULL DEFAULT 'good',
        ADD "accepted" boolean NOT NULL DEFAULT true,
        ADD "quantityReturned" integer NOT NULL DEFAULT 0,
        ADD CONSTRAINT "uq_goods_receipt_items_id_tenant" UNIQUE ("id", "tenantId"),
        ADD CONSTRAINT "chk_goods_receipt_items_returned" CHECK ("quantityReturned" >= 0 AND "quantityReturned" <= "quantity"),
        ADD CONSTRAINT "chk_goods_receipt_items_condition" CHECK ("accepted" OR "condition" = 'damaged')`);

    // ---- Supplier returns ----
    await queryRunner.query(`
      CREATE TABLE "supplier_returns" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "returnNumber" character varying(50) NOT NULL,
        "supplierId" uuid NOT NULL,
        "receiptId" uuid NOT NULL,
        "locationId" uuid NOT NULL,
        "reason" character varying(500) NOT NULL,
        "reference" character varying(100),
        "totalAmount" numeric(19,4) NOT NULL,
        "currencyCode" character(3) NOT NULL,
        "userId" uuid NOT NULL,
        "returnedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "uq_supplier_returns_number" UNIQUE ("tenantId", "returnNumber"),
        CONSTRAINT "uq_supplier_returns_id_tenant" UNIQUE ("id", "tenantId"),
        CONSTRAINT "PK_supplier_returns" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_returns_supplier" ON "supplier_returns" ("tenantId", "supplierId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_returns_receipt" ON "supplier_returns" ("receiptId")`,
    );
    await queryRunner.query(`
      CREATE TABLE "supplier_return_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "returnId" uuid NOT NULL,
        "receiptItemId" uuid NOT NULL,
        "variantId" uuid NOT NULL,
        "quantity" integer NOT NULL,
        "unitCost" numeric(19,4) NOT NULL,
        "total" numeric(19,4) NOT NULL,
        CONSTRAINT "chk_supplier_return_items_quantity" CHECK ("quantity" > 0),
        CONSTRAINT "PK_supplier_return_items" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_return_items_return" ON "supplier_return_items" ("returnId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_return_items_receipt_item" ON "supplier_return_items" ("receiptItemId")`,
    );

    // ---- Supplier invoices ----
    await queryRunner.query(`
      CREATE TABLE "supplier_invoices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "supplierId" uuid NOT NULL,
        "invoiceNumber" character varying(100) NOT NULL,
        "invoiceType" character varying(20) NOT NULL DEFAULT 'standard',
        "purchaseOrderId" uuid,
        "invoiceDate" date NOT NULL,
        "dueDate" date NOT NULL,
        "currencyCode" character(3) NOT NULL,
        "subtotal" numeric(19,4) NOT NULL,
        "taxAmount" numeric(19,4) NOT NULL DEFAULT '0',
        "total" numeric(19,4) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'pending_approval',
        "hasVariance" boolean NOT NULL DEFAULT false,
        "notes" character varying(500),
        "userId" uuid NOT NULL,
        "approvedById" uuid,
        "approvedAt" TIMESTAMP WITH TIME ZONE,
        "voidedAt" TIMESTAMP WITH TIME ZONE,
        "voidReason" character varying(500),
        CONSTRAINT "uq_supplier_invoices_id_tenant" UNIQUE ("id", "tenantId"),
        CONSTRAINT "chk_supplier_invoices_type" CHECK ("invoiceType" IN ('standard', 'opening_balance')),
        CONSTRAINT "chk_supplier_invoices_status" CHECK ("status" IN ('pending_approval', 'open', 'void')),
        CONSTRAINT "chk_supplier_invoices_total" CHECK ("total" > 0),
        CONSTRAINT "chk_supplier_invoices_due" CHECK ("dueDate" >= "invoiceDate"),
        CONSTRAINT "PK_supplier_invoices" PRIMARY KEY ("id")
      )`);
    // The same supplier invoice number only once (void ones excepted)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_supplier_invoices_number" ON "supplier_invoices" ("tenantId", "supplierId", lower("invoiceNumber")) WHERE "status" <> 'void'`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_invoices_supplier" ON "supplier_invoices" ("tenantId", "supplierId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_invoices_due" ON "supplier_invoices" ("tenantId", "dueDate")`,
    );
    await queryRunner.query(`
      CREATE TABLE "supplier_invoice_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "invoiceId" uuid NOT NULL,
        "lineNumber" integer NOT NULL,
        "purchaseOrderItemId" uuid,
        "receiptItemId" uuid,
        "variantId" uuid,
        "description" character varying(255) NOT NULL,
        "quantity" integer NOT NULL,
        "unitPrice" numeric(19,4) NOT NULL,
        "subtotal" numeric(19,4) NOT NULL,
        "taxAmount" numeric(19,4) NOT NULL DEFAULT '0',
        "total" numeric(19,4) NOT NULL,
        "expectedUnitPrice" numeric(19,4),
        "matchableQuantity" integer,
        "priceVariance" numeric(19,4) NOT NULL DEFAULT '0',
        "priceVariancePercent" numeric(9,4),
        "quantityVariance" integer NOT NULL DEFAULT 0,
        "varianceFlag" boolean NOT NULL DEFAULT false,
        CONSTRAINT "chk_supplier_invoice_items_quantity" CHECK ("quantity" > 0),
        CONSTRAINT "PK_supplier_invoice_items" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_invoice_items_invoice" ON "supplier_invoice_items" ("invoiceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_invoice_items_po_item" ON "supplier_invoice_items" ("purchaseOrderItemId")`,
    );

    // ---- Supplier credits ----
    await queryRunner.query(`
      CREATE TABLE "supplier_credits" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "creditNumber" character varying(50) NOT NULL,
        "supplierId" uuid NOT NULL,
        "creditType" character varying(20) NOT NULL,
        "returnId" uuid,
        "creditDate" date NOT NULL,
        "amount" numeric(19,4) NOT NULL,
        "currencyCode" character(3) NOT NULL,
        "reference" character varying(100),
        "reason" character varying(500) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'open',
        "userId" uuid NOT NULL,
        CONSTRAINT "uq_supplier_credits_number" UNIQUE ("tenantId", "creditNumber"),
        CONSTRAINT "uq_supplier_credits_id_tenant" UNIQUE ("id", "tenantId"),
        CONSTRAINT "chk_supplier_credits_type" CHECK ("creditType" IN ('return', 'manual')),
        CONSTRAINT "chk_supplier_credits_status" CHECK ("status" IN ('open', 'void')),
        CONSTRAINT "chk_supplier_credits_amount" CHECK ("amount" > 0),
        CONSTRAINT "PK_supplier_credits" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_credits_supplier" ON "supplier_credits" ("tenantId", "supplierId")`,
    );

    // ---- Supplier payments ----
    await queryRunner.query(`
      CREATE TABLE "supplier_payments" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "paymentNumber" character varying(50) NOT NULL,
        "supplierId" uuid NOT NULL,
        "paymentDate" date NOT NULL,
        "amount" numeric(19,4) NOT NULL,
        "currencyCode" character(3) NOT NULL,
        "method" character varying(20) NOT NULL,
        "reference" character varying(100),
        "notes" character varying(500),
        "status" character varying(20) NOT NULL DEFAULT 'posted',
        "voidedAt" TIMESTAMP WITH TIME ZONE,
        "voidReason" character varying(500),
        "userId" uuid NOT NULL,
        CONSTRAINT "uq_supplier_payments_number" UNIQUE ("tenantId", "paymentNumber"),
        CONSTRAINT "uq_supplier_payments_id_tenant" UNIQUE ("id", "tenantId"),
        CONSTRAINT "chk_supplier_payments_method" CHECK ("method" IN ('cash', 'bank_transfer', 'check', 'card', 'mobile_money', 'other')),
        CONSTRAINT "chk_supplier_payments_status" CHECK ("status" IN ('posted', 'void')),
        CONSTRAINT "chk_supplier_payments_amount" CHECK ("amount" > 0),
        CONSTRAINT "PK_supplier_payments" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_payments_supplier" ON "supplier_payments" ("tenantId", "supplierId")`,
    );

    // ---- Allocations of payments / credits to invoices ----
    await queryRunner.query(`
      CREATE TABLE "supplier_allocations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "supplierId" uuid NOT NULL,
        "invoiceId" uuid NOT NULL,
        "paymentId" uuid,
        "creditId" uuid,
        "amount" numeric(19,4) NOT NULL,
        "userId" uuid NOT NULL,
        CONSTRAINT "chk_supplier_allocations_source" CHECK (num_nonnulls("paymentId", "creditId") = 1),
        CONSTRAINT "chk_supplier_allocations_amount" CHECK ("amount" > 0),
        CONSTRAINT "PK_supplier_allocations" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_allocations_invoice" ON "supplier_allocations" ("invoiceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_allocations_payment" ON "supplier_allocations" ("paymentId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_allocations_credit" ON "supplier_allocations" ("creditId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_supplier_allocations_supplier" ON "supplier_allocations" ("tenantId", "supplierId")`,
    );

    // ---- Foreign keys (tenant-scoped: child (x, tenantId) → parent (id, tenantId)) ----
    const tenantFk = (table: string, name: string) =>
      [table, name, '"tenantId"', '"tenants"("id")', 'CASCADE'] as const;
    const userFk = (table: string, name: string, column: string) =>
      [table, name, `"${column}"`, '"users"("id")', 'RESTRICT'] as const;
    const fks: (readonly [string, string, string, string, string])[] = [
      // supplier_products
      tenantFk('supplier_products', 'fk_supplier_products_tenant'),
      [
        'supplier_products',
        'fk_supplier_products_supplier',
        '"supplierId", "tenantId"',
        '"suppliers"("id","tenantId")',
        'CASCADE',
      ],
      [
        'supplier_products',
        'fk_supplier_products_variant',
        '"variantId", "tenantId"',
        '"product_variants"("id","tenantId")',
        'CASCADE',
      ],
      // purchase_order_revisions
      tenantFk(
        'purchase_order_revisions',
        'fk_purchase_order_revisions_tenant',
      ),
      [
        'purchase_order_revisions',
        'fk_purchase_order_revisions_order',
        '"purchaseOrderId", "tenantId"',
        '"purchase_orders"("id","tenantId")',
        'CASCADE',
      ],
      userFk(
        'purchase_order_revisions',
        'fk_purchase_order_revisions_user',
        'userId',
      ),
      // goods_receipts
      [
        'goods_receipts',
        'fk_goods_receipts_supplier',
        '"supplierId", "tenantId"',
        '"suppliers"("id","tenantId")',
        'RESTRICT',
      ],
      // supplier_returns
      tenantFk('supplier_returns', 'fk_supplier_returns_tenant'),
      [
        'supplier_returns',
        'fk_supplier_returns_supplier',
        '"supplierId", "tenantId"',
        '"suppliers"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'supplier_returns',
        'fk_supplier_returns_receipt',
        '"receiptId", "tenantId"',
        '"goods_receipts"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'supplier_returns',
        'fk_supplier_returns_location',
        '"locationId", "tenantId"',
        '"inventory_locations"("id","tenantId")',
        'RESTRICT',
      ],
      userFk('supplier_returns', 'fk_supplier_returns_user', 'userId'),
      // supplier_return_items
      tenantFk('supplier_return_items', 'fk_supplier_return_items_tenant'),
      [
        'supplier_return_items',
        'fk_supplier_return_items_return',
        '"returnId", "tenantId"',
        '"supplier_returns"("id","tenantId")',
        'CASCADE',
      ],
      [
        'supplier_return_items',
        'fk_supplier_return_items_receipt_item',
        '"receiptItemId", "tenantId"',
        '"goods_receipt_items"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'supplier_return_items',
        'fk_supplier_return_items_variant',
        '"variantId", "tenantId"',
        '"product_variants"("id","tenantId")',
        'RESTRICT',
      ],
      // supplier_invoices
      tenantFk('supplier_invoices', 'fk_supplier_invoices_tenant'),
      [
        'supplier_invoices',
        'fk_supplier_invoices_supplier',
        '"supplierId", "tenantId"',
        '"suppliers"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'supplier_invoices',
        'fk_supplier_invoices_purchase_order',
        '"purchaseOrderId", "tenantId"',
        '"purchase_orders"("id","tenantId")',
        'RESTRICT',
      ],
      userFk('supplier_invoices', 'fk_supplier_invoices_user', 'userId'),
      // supplier_invoice_items
      tenantFk('supplier_invoice_items', 'fk_supplier_invoice_items_tenant'),
      [
        'supplier_invoice_items',
        'fk_supplier_invoice_items_invoice',
        '"invoiceId", "tenantId"',
        '"supplier_invoices"("id","tenantId")',
        'CASCADE',
      ],
      [
        'supplier_invoice_items',
        'fk_supplier_invoice_items_po_item',
        '"purchaseOrderItemId", "tenantId"',
        '"purchase_order_items"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'supplier_invoice_items',
        'fk_supplier_invoice_items_receipt_item',
        '"receiptItemId", "tenantId"',
        '"goods_receipt_items"("id","tenantId")',
        'RESTRICT',
      ],
      // supplier_credits
      tenantFk('supplier_credits', 'fk_supplier_credits_tenant'),
      [
        'supplier_credits',
        'fk_supplier_credits_supplier',
        '"supplierId", "tenantId"',
        '"suppliers"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'supplier_credits',
        'fk_supplier_credits_return',
        '"returnId", "tenantId"',
        '"supplier_returns"("id","tenantId")',
        'RESTRICT',
      ],
      userFk('supplier_credits', 'fk_supplier_credits_user', 'userId'),
      // supplier_payments
      tenantFk('supplier_payments', 'fk_supplier_payments_tenant'),
      [
        'supplier_payments',
        'fk_supplier_payments_supplier',
        '"supplierId", "tenantId"',
        '"suppliers"("id","tenantId")',
        'RESTRICT',
      ],
      userFk('supplier_payments', 'fk_supplier_payments_user', 'userId'),
      // supplier_allocations
      tenantFk('supplier_allocations', 'fk_supplier_allocations_tenant'),
      [
        'supplier_allocations',
        'fk_supplier_allocations_invoice',
        '"invoiceId", "tenantId"',
        '"supplier_invoices"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'supplier_allocations',
        'fk_supplier_allocations_payment',
        '"paymentId", "tenantId"',
        '"supplier_payments"("id","tenantId")',
        'CASCADE',
      ],
      [
        'supplier_allocations',
        'fk_supplier_allocations_credit',
        '"creditId", "tenantId"',
        '"supplier_credits"("id","tenantId")',
        'CASCADE',
      ],
    ];
    for (const [table, name, columns, references, onDelete] of fks) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY (${columns}) REFERENCES ${references} ON DELETE ${onDelete} ON UPDATE NO ACTION`,
      );
    }

    // ---- Permissions for the built-in roles ----
    for (const key of this.permissions) {
      await queryRunner.query(
        `UPDATE "tenant_roles" SET "permissions" = "permissions" || jsonb_build_array($1::text)
         WHERE "isSystem" = true AND "key" IN ('owner', 'admin', 'manager') AND NOT "permissions" ? $1`,
        [key],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const key of this.permissions) {
      await queryRunner.query(
        `UPDATE "tenant_roles" SET "permissions" = "permissions" - $1::text WHERE "permissions" ? $1`,
        [key],
      );
    }

    await queryRunner.query(`DROP TABLE "supplier_allocations"`);
    await queryRunner.query(`DROP TABLE "supplier_payments"`);
    await queryRunner.query(`DROP TABLE "supplier_credits"`);
    await queryRunner.query(`DROP TABLE "supplier_invoice_items"`);
    await queryRunner.query(`DROP TABLE "supplier_invoices"`);
    await queryRunner.query(`DROP TABLE "supplier_return_items"`);
    await queryRunner.query(`DROP TABLE "supplier_returns"`);

    // Unplanned receipts cannot exist without the new columns
    await queryRunner.query(
      `DELETE FROM "goods_receipts" WHERE "purchaseOrderId" IS NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "goods_receipt_items"
        DROP CONSTRAINT "chk_goods_receipt_items_condition",
        DROP CONSTRAINT "chk_goods_receipt_items_returned",
        DROP CONSTRAINT "uq_goods_receipt_items_id_tenant",
        DROP COLUMN "quantityReturned",
        DROP COLUMN "accepted",
        DROP COLUMN "condition",
        ALTER COLUMN "purchaseOrderItemId" SET NOT NULL`);
    await queryRunner.query(
      `DROP TYPE "public"."goods_receipt_items_condition_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "goods_receipts" DROP CONSTRAINT "fk_goods_receipts_supplier"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_goods_receipts_supplier"`,
    );
    await queryRunner.query(`
      ALTER TABLE "goods_receipts"
        DROP COLUMN "overReceiptApprovedById",
        DROP COLUMN "supplierId",
        ALTER COLUMN "purchaseOrderId" SET NOT NULL`);

    await queryRunner.query(`DROP TABLE "purchase_order_revisions"`);
    await queryRunner.query(`
      ALTER TABLE "purchase_order_items"
        DROP CONSTRAINT "chk_purchase_order_items_discount",
        DROP CONSTRAINT "chk_purchase_order_items_quantities",
        DROP COLUMN "supplierSku",
        DROP COLUMN "unitOfMeasure",
        DROP COLUMN "discountAmount",
        DROP COLUMN "discountPercent",
        DROP COLUMN "quantityCancelled"`);
    await queryRunner.query(`
      ALTER TABLE "purchase_orders"
        DROP COLUMN "revisedById",
        DROP COLUMN "revisionNumber",
        DROP COLUMN "closeReason",
        DROP COLUMN "closedAt",
        DROP COLUMN "supplierReference",
        DROP COLUMN "discountAmount"`);
    // Postgres cannot drop an enum value: rebuild the type without 'closed'
    await queryRunner.query(
      `UPDATE "purchase_orders" SET "status" = 'received' WHERE "status" = 'closed'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."purchase_orders_status_enum" RENAME TO "purchase_orders_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."purchase_orders_status_enum" AS ENUM('draft', 'pending_approval', 'approved', 'issued', 'partially_received', 'received', 'cancelled')`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ALTER COLUMN "status" TYPE "public"."purchase_orders_status_enum" USING "status"::text::"public"."purchase_orders_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ALTER COLUMN "status" SET DEFAULT 'draft'`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."purchase_orders_status_enum_old"`,
    );

    await queryRunner.query(`DROP TABLE "supplier_products"`);
    await queryRunner.query(
      `ALTER TABLE "suppliers" DROP CONSTRAINT "uq_suppliers_id_tenant"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suppliers" DROP CONSTRAINT "chk_suppliers_lead_time"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suppliers" DROP COLUMN "leadTimeDays"`,
    );
  }
}
