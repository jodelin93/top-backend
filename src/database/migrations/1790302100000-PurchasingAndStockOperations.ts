import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Purchasing and advanced inventory:
 * - suppliers: currency, notes, contacts (R070)
 * - purchase orders: destination location, approval / issue / cancel lifecycle (R071)
 * - goods receipts against a PO with an idempotency key (R072/R073)
 * - stock count sessions (R065)
 * - stock transfers between locations (R067)
 * purchase_orders was unused before this migration (no rows), so its status
 * values are renamed in place.
 */
export class PurchasingAndStockOperations1790302100000 implements MigrationInterface {
  name = 'PurchasingAndStockOperations1790302100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---- Suppliers ----
    await queryRunner.query(`
      ALTER TABLE "suppliers"
        ADD "currencyCode" character(3),
        ADD "notes" text,
        ADD "contacts" jsonb NOT NULL DEFAULT '[]'`);

    // ---- Purchase orders ----
    await queryRunner.query(
      `ALTER TYPE "public"."purchase_orders_status_enum" RENAME VALUE 'pending' TO 'pending_approval'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."purchase_orders_status_enum" RENAME VALUE 'ordered' TO 'issued'`,
    );
    await queryRunner.query(`
      ALTER TABLE "purchase_orders"
        ADD "locationId" uuid NOT NULL,
        ADD "submittedAt" TIMESTAMP WITH TIME ZONE,
        ADD "approvedById" uuid,
        ADD "approvedAt" TIMESTAMP WITH TIME ZONE,
        ADD "issuedAt" TIMESTAMP WITH TIME ZONE,
        ADD "receivedAt" TIMESTAMP WITH TIME ZONE,
        ADD "cancelledAt" TIMESTAMP WITH TIME ZONE,
        ADD "cancelReason" character varying(500)`);
    await queryRunner.query(
      `CREATE INDEX "idx_purchase_orders_location" ON "purchase_orders" ("locationId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD CONSTRAINT "fk_purchase_orders_location" FOREIGN KEY ("locationId", "tenantId") REFERENCES "inventory_locations"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" ADD CONSTRAINT "uq_purchase_order_items_id_tenant" UNIQUE ("id", "tenantId")`,
    );

    // ---- Goods receipts ----
    await queryRunner.query(`
      CREATE TABLE "goods_receipts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "receiptNumber" character varying(50) NOT NULL,
        "purchaseOrderId" uuid NOT NULL,
        "locationId" uuid NOT NULL,
        "idempotencyKey" character varying(100) NOT NULL,
        "receivedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "reference" character varying(100),
        "notes" character varying(500),
        "totalCost" numeric(19,4) NOT NULL DEFAULT '0',
        "userId" uuid NOT NULL,
        CONSTRAINT "uq_goods_receipts_number" UNIQUE ("tenantId", "receiptNumber"),
        CONSTRAINT "uq_goods_receipts_idempotency" UNIQUE ("tenantId", "idempotencyKey"),
        CONSTRAINT "uq_goods_receipts_id_tenant" UNIQUE ("id", "tenantId"),
        CONSTRAINT "PK_goods_receipts" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_goods_receipts_purchase_order" ON "goods_receipts" ("purchaseOrderId")`,
    );
    await queryRunner.query(`
      CREATE TABLE "goods_receipt_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "receiptId" uuid NOT NULL,
        "purchaseOrderItemId" uuid NOT NULL,
        "variantId" uuid NOT NULL,
        "quantity" integer NOT NULL,
        "unitCost" numeric(19,4) NOT NULL,
        CONSTRAINT "PK_goods_receipt_items" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_goods_receipt_items_receipt" ON "goods_receipt_items" ("receiptId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_goods_receipt_items_po_item" ON "goods_receipt_items" ("purchaseOrderItemId")`,
    );

    // ---- Stock counts ----
    await queryRunner.query(
      `CREATE TYPE "public"."stock_counts_status_enum" AS ENUM('in_progress', 'pending_approval', 'posted', 'cancelled')`,
    );
    await queryRunner.query(`
      CREATE TABLE "stock_counts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "countNumber" character varying(50) NOT NULL,
        "locationId" uuid NOT NULL,
        "categoryId" uuid,
        "blind" boolean NOT NULL DEFAULT false,
        "status" "public"."stock_counts_status_enum" NOT NULL DEFAULT 'in_progress',
        "notes" character varying(500),
        "createdById" uuid NOT NULL,
        "submittedById" uuid,
        "submittedAt" TIMESTAMP WITH TIME ZONE,
        "approvedById" uuid,
        "approvedAt" TIMESTAMP WITH TIME ZONE,
        "postedAt" TIMESTAMP WITH TIME ZONE,
        "cancelledAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "uq_stock_counts_number" UNIQUE ("tenantId", "countNumber"),
        CONSTRAINT "uq_stock_counts_id_tenant" UNIQUE ("id", "tenantId"),
        CONSTRAINT "PK_stock_counts" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_stock_counts_tenant_status" ON "stock_counts" ("tenantId", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_stock_counts_location" ON "stock_counts" ("locationId")`,
    );
    await queryRunner.query(`
      CREATE TABLE "stock_count_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "countId" uuid NOT NULL,
        "variantId" uuid NOT NULL,
        "expectedQuantity" integer NOT NULL,
        "countedQuantity" integer,
        "variance" integer,
        "unitCost" numeric(19,4),
        "countedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "uq_stock_count_items_variant" UNIQUE ("countId", "variantId"),
        CONSTRAINT "PK_stock_count_items" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_stock_count_items_tenant" ON "stock_count_items" ("tenantId")`,
    );

    // ---- Stock transfers ----
    await queryRunner.query(
      `CREATE TYPE "public"."stock_transfers_status_enum" AS ENUM('draft', 'in_transit', 'partially_received', 'received', 'cancelled')`,
    );
    await queryRunner.query(`
      CREATE TABLE "stock_transfers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "transferNumber" character varying(50) NOT NULL,
        "fromLocationId" uuid NOT NULL,
        "toLocationId" uuid NOT NULL,
        "status" "public"."stock_transfers_status_enum" NOT NULL DEFAULT 'draft',
        "notes" character varying(500),
        "createdById" uuid NOT NULL,
        "dispatchedAt" TIMESTAMP WITH TIME ZONE,
        "dispatchedById" uuid,
        "receivedAt" TIMESTAMP WITH TIME ZONE,
        "cancelledAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "uq_stock_transfers_number" UNIQUE ("tenantId", "transferNumber"),
        CONSTRAINT "uq_stock_transfers_id_tenant" UNIQUE ("id", "tenantId"),
        CONSTRAINT "PK_stock_transfers" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_stock_transfers_tenant_status" ON "stock_transfers" ("tenantId", "status")`,
    );
    await queryRunner.query(`
      CREATE TABLE "stock_transfer_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "transferId" uuid NOT NULL,
        "variantId" uuid NOT NULL,
        "quantityRequested" integer NOT NULL,
        "quantityDispatched" integer NOT NULL DEFAULT 0,
        "quantityReceived" integer NOT NULL DEFAULT 0,
        "quantityWrittenOff" integer NOT NULL DEFAULT 0,
        "unitCost" numeric(19,4),
        CONSTRAINT "uq_stock_transfer_items_variant" UNIQUE ("transferId", "variantId"),
        CONSTRAINT "PK_stock_transfer_items" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_stock_transfer_items_tenant" ON "stock_transfer_items" ("tenantId")`,
    );

    // ---- Foreign keys ----
    const fks: [string, string, string, string, string][] = [
      // [table, constraint, columns, references, on delete]
      [
        'goods_receipts',
        'fk_goods_receipts_tenant',
        '"tenantId"',
        '"tenants"("id")',
        'CASCADE',
      ],
      [
        'goods_receipts',
        'fk_goods_receipts_purchase_order',
        '"purchaseOrderId", "tenantId"',
        '"purchase_orders"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'goods_receipts',
        'fk_goods_receipts_location',
        '"locationId", "tenantId"',
        '"inventory_locations"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'goods_receipts',
        'fk_goods_receipts_user',
        '"userId"',
        '"users"("id")',
        'RESTRICT',
      ],
      [
        'goods_receipt_items',
        'fk_goods_receipt_items_tenant',
        '"tenantId"',
        '"tenants"("id")',
        'CASCADE',
      ],
      [
        'goods_receipt_items',
        'fk_goods_receipt_items_receipt',
        '"receiptId", "tenantId"',
        '"goods_receipts"("id","tenantId")',
        'CASCADE',
      ],
      [
        'goods_receipt_items',
        'fk_goods_receipt_items_po_item',
        '"purchaseOrderItemId", "tenantId"',
        '"purchase_order_items"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'goods_receipt_items',
        'fk_goods_receipt_items_variant',
        '"variantId", "tenantId"',
        '"product_variants"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'stock_counts',
        'fk_stock_counts_tenant',
        '"tenantId"',
        '"tenants"("id")',
        'CASCADE',
      ],
      [
        'stock_counts',
        'fk_stock_counts_location',
        '"locationId", "tenantId"',
        '"inventory_locations"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'stock_counts',
        'fk_stock_counts_created_by',
        '"createdById"',
        '"users"("id")',
        'RESTRICT',
      ],
      [
        'stock_count_items',
        'fk_stock_count_items_tenant',
        '"tenantId"',
        '"tenants"("id")',
        'CASCADE',
      ],
      [
        'stock_count_items',
        'fk_stock_count_items_count',
        '"countId", "tenantId"',
        '"stock_counts"("id","tenantId")',
        'CASCADE',
      ],
      [
        'stock_count_items',
        'fk_stock_count_items_variant',
        '"variantId", "tenantId"',
        '"product_variants"("id","tenantId")',
        'CASCADE',
      ],
      [
        'stock_transfers',
        'fk_stock_transfers_tenant',
        '"tenantId"',
        '"tenants"("id")',
        'CASCADE',
      ],
      [
        'stock_transfers',
        'fk_stock_transfers_from_location',
        '"fromLocationId", "tenantId"',
        '"inventory_locations"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'stock_transfers',
        'fk_stock_transfers_to_location',
        '"toLocationId", "tenantId"',
        '"inventory_locations"("id","tenantId")',
        'RESTRICT',
      ],
      [
        'stock_transfers',
        'fk_stock_transfers_created_by',
        '"createdById"',
        '"users"("id")',
        'RESTRICT',
      ],
      [
        'stock_transfer_items',
        'fk_stock_transfer_items_tenant',
        '"tenantId"',
        '"tenants"("id")',
        'CASCADE',
      ],
      [
        'stock_transfer_items',
        'fk_stock_transfer_items_transfer',
        '"transferId", "tenantId"',
        '"stock_transfers"("id","tenantId")',
        'CASCADE',
      ],
      [
        'stock_transfer_items',
        'fk_stock_transfer_items_variant',
        '"variantId", "tenantId"',
        '"product_variants"("id","tenantId")',
        'RESTRICT',
      ],
    ];
    for (const [table, name, columns, references, onDelete] of fks) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY (${columns}) REFERENCES ${references} ON DELETE ${onDelete} ON UPDATE NO ACTION`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "stock_transfer_items"`);
    await queryRunner.query(`DROP TABLE "stock_transfers"`);
    await queryRunner.query(`DROP TYPE "public"."stock_transfers_status_enum"`);
    await queryRunner.query(`DROP TABLE "stock_count_items"`);
    await queryRunner.query(`DROP TABLE "stock_counts"`);
    await queryRunner.query(`DROP TYPE "public"."stock_counts_status_enum"`);
    await queryRunner.query(`DROP TABLE "goods_receipt_items"`);
    await queryRunner.query(`DROP TABLE "goods_receipts"`);

    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" DROP CONSTRAINT "uq_purchase_order_items_id_tenant"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP CONSTRAINT "fk_purchase_orders_location"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."idx_purchase_orders_location"`,
    );
    await queryRunner.query(`
      ALTER TABLE "purchase_orders"
        DROP COLUMN "cancelReason",
        DROP COLUMN "cancelledAt",
        DROP COLUMN "receivedAt",
        DROP COLUMN "issuedAt",
        DROP COLUMN "approvedAt",
        DROP COLUMN "approvedById",
        DROP COLUMN "submittedAt",
        DROP COLUMN "locationId"`);
    await queryRunner.query(
      `ALTER TYPE "public"."purchase_orders_status_enum" RENAME VALUE 'issued' TO 'ordered'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."purchase_orders_status_enum" RENAME VALUE 'pending_approval' TO 'pending'`,
    );

    await queryRunner.query(`
      ALTER TABLE "suppliers"
        DROP COLUMN "contacts",
        DROP COLUMN "notes",
        DROP COLUMN "currencyCode"`);
  }
}
