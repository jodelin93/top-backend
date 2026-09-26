import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTaxCategoriesAndBarcodes1790275803607 implements MigrationInterface {
  name = 'AddTaxCategoriesAndBarcodes1790275803607';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "tax_categories" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" jsonb NOT NULL, "description" character varying(255), "taxRateId" uuid, CONSTRAINT "uq_tax_category_code" UNIQUE ("tenantId", "code"), CONSTRAINT "PK_8ffdbb5cc33edf05151ae59cb30" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_tax_categories_tenant" ON "tax_categories"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "product_barcodes" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "variantId" uuid NOT NULL, "barcode" character varying(100) NOT NULL, "isPrimary" boolean NOT NULL DEFAULT false, CONSTRAINT "uq_product_barcode" UNIQUE ("tenantId", "barcode"), CONSTRAINT "PK_459d7d53aebb732e6c8460247d6" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_product_barcodes_variant" ON "product_barcodes"  ("variantId") `,
    );
    // Existing barcodes become each variant's primary entry
    await queryRunner.query(`INSERT INTO "product_barcodes" ("tenantId", "variantId", "barcode", "isPrimary")
            SELECT DISTINCT ON ("tenantId", "barcode") "tenantId", "id", "barcode", true
            FROM "product_variants" WHERE "barcode" IS NOT NULL AND "barcode" <> ''
            ORDER BY "tenantId", "barcode", "created_at"`);
    await queryRunner.query(`ALTER TABLE "products" ADD "taxCategoryId" uuid`);
    await queryRunner.query(
      `ALTER TABLE "tax_categories" ADD CONSTRAINT "FK_tax_categories_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tax_categories" ADD CONSTRAINT "FK_tax_categories_rate" FOREIGN KEY ("taxRateId") REFERENCES "tax_rates"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "FK_products_tax_category" FOREIGN KEY ("taxCategoryId") REFERENCES "tax_categories"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_barcodes" ADD CONSTRAINT "FK_product_barcodes_variant" FOREIGN KEY ("variantId") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "product_barcodes" DROP CONSTRAINT "FK_product_barcodes_variant"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT "FK_products_tax_category"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tax_categories" DROP CONSTRAINT "FK_tax_categories_rate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "tax_categories" DROP CONSTRAINT "FK_tax_categories_tenant"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP COLUMN "taxCategoryId"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_product_barcodes_variant"`,
    );
    await queryRunner.query(`DROP TABLE "product_barcodes"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_tax_categories_tenant"`);
    await queryRunner.query(`DROP TABLE "tax_categories"`);
  }
}
