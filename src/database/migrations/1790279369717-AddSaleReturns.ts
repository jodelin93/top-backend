import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSaleReturns1790279369717 implements MigrationInterface {
  name = 'AddSaleReturns1790279369717';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."sale_return_refunds_status_enum" AS ENUM('pending', 'completed', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "sale_return_refunds" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "returnId" uuid NOT NULL, "paymentMethodId" uuid NOT NULL, "originalPaymentId" uuid, "amount" numeric(19,4) NOT NULL, "provider" character varying(50), "providerReference" character varying(255), "idempotencyKey" character varying(150) NOT NULL, "status" "public"."sale_return_refunds_status_enum" NOT NULL DEFAULT 'pending', "failureReason" character varying(500), CONSTRAINT "PK_e855786b38257a44cecd6490d9f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_return_refunds_payment" ON "sale_return_refunds"  ("originalPaymentId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_return_refunds_return" ON "sale_return_refunds"  ("returnId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."sale_returns_status_enum" AS ENUM('completed', 'refund_pending', 'refund_failed')`,
    );
    await queryRunner.query(
      `CREATE TABLE "sale_returns" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "returnNumber" character varying(50) NOT NULL, "originalSaleId" uuid NOT NULL, "registerId" uuid NOT NULL, "shiftId" uuid, "customerId" uuid, "userId" uuid NOT NULL, "approverId" uuid, "reason" character varying(500) NOT NULL, "subtotal" numeric(19,4) NOT NULL, "discountAmount" numeric(19,4) NOT NULL, "taxAmount" numeric(19,4) NOT NULL, "total" numeric(19,4) NOT NULL, "currencyCode" character(3) NOT NULL, "status" "public"."sale_returns_status_enum" NOT NULL DEFAULT 'completed', "idempotencyKey" character varying(100), CONSTRAINT "uq_return_number" UNIQUE ("tenantId", "returnNumber"), CONSTRAINT "PK_0dacb97f81ef1ca47f61409f844" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_return_idempotency" ON "sale_returns"  ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_returns_sale" ON "sale_returns"  ("originalSaleId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_returns_tenant_created" ON "sale_returns"  ("tenantId", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."sale_return_items_disposition_enum" AS ENUM('restock', 'dispose')`,
    );
    await queryRunner.query(
      `CREATE TABLE "sale_return_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "returnId" uuid NOT NULL, "saleItemId" uuid NOT NULL, "variantId" uuid NOT NULL, "sku" character varying(100) NOT NULL, "productName" character varying(255) NOT NULL, "variantName" character varying(255), "quantity" integer NOT NULL, "unitPrice" numeric(19,4) NOT NULL, "subtotal" numeric(19,4) NOT NULL, "discountAmount" numeric(19,4) NOT NULL, "taxAmount" numeric(19,4) NOT NULL, "total" numeric(19,4) NOT NULL, "disposition" "public"."sale_return_items_disposition_enum" NOT NULL, "locationId" uuid, "reason" character varying(255), CONSTRAINT "PK_87c0813662620cbb412d65c0cc4" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_return_items_sale_item" ON "sale_return_items"  ("saleItemId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_return_items_return" ON "sale_return_items"  ("returnId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_return_refunds" ADD CONSTRAINT "FK_return_refunds_return" FOREIGN KEY ("returnId") REFERENCES "sale_returns"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_return_refunds" ADD CONSTRAINT "FK_return_refunds_method" FOREIGN KEY ("paymentMethodId") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_returns" ADD CONSTRAINT "FK_returns_sale" FOREIGN KEY ("originalSaleId") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_return_items" ADD CONSTRAINT "FK_return_items_return" FOREIGN KEY ("returnId") REFERENCES "sale_returns"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_return_items" ADD CONSTRAINT "FK_return_items_sale_item" FOREIGN KEY ("saleItemId") REFERENCES "sale_items"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sale_return_items" DROP CONSTRAINT "FK_return_items_sale_item"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_return_items" DROP CONSTRAINT "FK_return_items_return"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_returns" DROP CONSTRAINT "FK_returns_sale"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_return_refunds" DROP CONSTRAINT "FK_return_refunds_method"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_return_refunds" DROP CONSTRAINT "FK_return_refunds_return"`,
    );
    await queryRunner.query(`DROP TABLE "sale_return_items"`);
    await queryRunner.query(
      `DROP TYPE "public"."sale_return_items_disposition_enum"`,
    );
    await queryRunner.query(`DROP TABLE "sale_returns"`);
    await queryRunner.query(`DROP TYPE "public"."sale_returns_status_enum"`);
    await queryRunner.query(`DROP TABLE "sale_return_refunds"`);
    await queryRunner.query(
      `DROP TYPE "public"."sale_return_refunds_status_enum"`,
    );
  }
}
