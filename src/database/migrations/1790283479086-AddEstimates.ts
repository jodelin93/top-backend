import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddEstimates1790283479086 implements MigrationInterface {
  name = 'AddEstimates1790283479086';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."estimates_status_enum" AS ENUM('draft', 'sent', 'accepted', 'declined', 'converted')`,
    );
    await queryRunner.query(
      `CREATE TABLE "estimates" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "estimateNumber" character varying(50) NOT NULL, "customerId" uuid, "customerName" character varying(255), "branchId" uuid, "userId" uuid NOT NULL, "status" "public"."estimates_status_enum" NOT NULL DEFAULT 'draft', "issueDate" date NOT NULL, "validUntil" date NOT NULL, "subtotal" numeric(19,4) NOT NULL, "discountAmount" numeric(19,4) NOT NULL, "taxAmount" numeric(19,4) NOT NULL, "total" numeric(19,4) NOT NULL, "currencyCode" character(3) NOT NULL, "cartDiscount" jsonb, "notes" character varying(1000), "terms" character varying(2000), "sentAt" TIMESTAMP WITH TIME ZONE, "respondedAt" TIMESTAMP WITH TIME ZONE, "convertedSaleId" uuid, CONSTRAINT "uq_estimate_number" UNIQUE ("tenantId", "estimateNumber"), CONSTRAINT "PK_447af75b2f6025adf7f80703810" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_estimates_customer" ON "estimates"  ("customerId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_estimates_tenant_created" ON "estimates"  ("tenantId", "created_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "estimate_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "estimateId" uuid NOT NULL, "variantId" uuid NOT NULL, "sku" character varying(100) NOT NULL, "productName" character varying(255) NOT NULL, "variantName" character varying(255), "quantity" integer NOT NULL, "unitPrice" numeric(19,4) NOT NULL, "catalogPrice" numeric(19,4) NOT NULL, "discountPercent" numeric(5,2) NOT NULL DEFAULT '0', "subtotal" numeric(19,4) NOT NULL, "discountAmount" numeric(19,4) NOT NULL, "taxRate" numeric(5,2), "taxAmount" numeric(19,4) NOT NULL, "total" numeric(19,4) NOT NULL, "note" character varying(500), "lineNumber" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_fc9186f62e2406698ab45a3012c" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_estimate_items_estimate" ON "estimate_items"  ("estimateId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "estimates" ADD CONSTRAINT "FK_estimates_customer" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "estimate_items" ADD CONSTRAINT "FK_estimate_items_estimate" FOREIGN KEY ("estimateId") REFERENCES "estimates"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    // Existing stores' built-in roles get the new permission (owners have everything)
    await queryRunner.query(`UPDATE "tenant_roles" SET "permissions" = "permissions" || '["estimates.manage"]'::jsonb
            WHERE "isSystem" = true AND "key" IN ('admin', 'manager', 'cashier') AND NOT "permissions" ? 'estimates.manage'`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "estimate_items" DROP CONSTRAINT "FK_estimate_items_estimate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "estimates" DROP CONSTRAINT "FK_estimates_customer"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_estimate_items_estimate"`,
    );
    await queryRunner.query(`DROP TABLE "estimate_items"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_estimates_tenant_created"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_estimates_customer"`);
    await queryRunner.query(`DROP TABLE "estimates"`);
    await queryRunner.query(`DROP TYPE "public"."estimates_status_enum"`);
  }
}
