import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Catalog & customers features:
 * - product images stored in object storage (storage key, type, size)
 * - variant generation settings on products, longer variant image URLs
 * - customer groups, configurable customer fields, marketing consent + history,
 *   merge tracking, and indexes for duplicate detection (pg_trgm when available)
 */
export class CatalogCustomersFeatures1790276199776 implements MigrationInterface {
  name = 'CatalogCustomersFeatures1790276199776';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- Catalog ---------------------------------------------------------
    await queryRunner.query(
      `ALTER TABLE "product_images" ADD "storageKey" character varying(300)`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" ADD "contentType" character varying(50)`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" ADD "sizeBytes" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD "variantAttributes" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ALTER COLUMN "imageUrl" TYPE character varying(500)`,
    );

    // --- Customer groups --------------------------------------------------
    await queryRunner.query(
      `CREATE TABLE "customer_groups" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "code" character varying(50) NOT NULL,
        "name" character varying(100) NOT NULL,
        "description" character varying(255),
        "priceListId" uuid,
        "discountPercent" numeric(5,2) NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        CONSTRAINT "uq_customer_group_code" UNIQUE ("tenantId", "code"),
        CONSTRAINT "CHK_customer_groups_discount" CHECK ("discountPercent" >= 0 AND "discountPercent" <= 100),
        CONSTRAINT "PK_customer_groups" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_groups_tenant" ON "customer_groups" ("tenantId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_groups" ADD CONSTRAINT "FK_customer_groups_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_groups" ADD CONSTRAINT "FK_customer_groups_price_list" FOREIGN KEY ("priceListId") REFERENCES "price_lists"("id") ON DELETE SET NULL`,
    );

    // --- Configurable customer fields ------------------------------------
    await queryRunner.query(
      `CREATE TYPE "public"."customer_field_definitions_fieldtype_enum" AS ENUM('text', 'number', 'date', 'select', 'boolean')`,
    );
    await queryRunner.query(
      `CREATE TABLE "customer_field_definitions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "key" character varying(50) NOT NULL,
        "label" character varying(100) NOT NULL,
        "fieldType" "public"."customer_field_definitions_fieldtype_enum" NOT NULL DEFAULT 'text',
        "isRequired" boolean NOT NULL DEFAULT false,
        "options" jsonb,
        "sortOrder" integer NOT NULL DEFAULT 0,
        "isActive" boolean NOT NULL DEFAULT true,
        CONSTRAINT "uq_customer_field_key" UNIQUE ("tenantId", "key"),
        CONSTRAINT "PK_customer_field_definitions" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_field_definitions_tenant" ON "customer_field_definitions" ("tenantId")`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_field_definitions" ADD CONSTRAINT "FK_customer_field_definitions_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE`,
    );

    // --- Customers: group, consent, merge ---------------------------------
    await queryRunner.query(`ALTER TABLE "customers" ADD "groupId" uuid`);
    await queryRunner.query(
      `ALTER TABLE "customers" ADD "marketingEmailConsent" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" ADD "marketingSmsConsent" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" ADD "consentUpdatedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" ADD "consentSource" character varying(50)`,
    );
    await queryRunner.query(`ALTER TABLE "customers" ADD "mergedIntoId" uuid`);
    await queryRunner.query(
      `ALTER TABLE "customers" ADD CONSTRAINT "FK_customers_group" FOREIGN KEY ("groupId") REFERENCES "customer_groups"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" ADD CONSTRAINT "FK_customers_merged_into" FOREIGN KEY ("mergedIntoId") REFERENCES "customers"("id") ON DELETE SET NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customers_group" ON "customers" ("groupId")`,
    );
    // Duplicate detection: normalised email / phone lookups
    await queryRunner.query(
      `CREATE INDEX "IDX_customers_email_norm" ON "customers" ("tenantId", lower(btrim("email"))) WHERE "email" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customers_phone_norm" ON "customers" ("tenantId", regexp_replace("phone", '[^0-9]', '', 'g')) WHERE "phone" IS NOT NULL`,
    );

    // --- Consent history (append-only) ------------------------------------
    await queryRunner.query(
      `CREATE TABLE "customer_consent_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "customerId" uuid NOT NULL,
        "channel" character varying(20) NOT NULL,
        "granted" boolean NOT NULL,
        "source" character varying(50),
        "note" character varying(255),
        "recordedById" uuid,
        CONSTRAINT "PK_customer_consent_events" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_customer_consent_events_customer" ON "customer_consent_events" ("tenantId", "customerId", "created_at")`,
    );
    await queryRunner.query(
      `ALTER TABLE "customer_consent_events" ADD CONSTRAINT "FK_customer_consent_events_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE`,
    );
    // Deleting a customer (right to erasure) removes their consent history too
    await queryRunner.query(
      `ALTER TABLE "customer_consent_events" ADD CONSTRAINT "FK_customer_consent_events_customer" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE`,
    );
    // Rows can't be edited; only re-pointing to the surviving customer of a merge is allowed
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION customer_consent_events_append_only() RETURNS trigger AS $$
       BEGIN
         IF (to_jsonb(NEW) - 'customerId') IS DISTINCT FROM (to_jsonb(OLD) - 'customerId') THEN
           RAISE EXCEPTION 'customer_consent_events is append-only';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "TRG_customer_consent_events_append_only" BEFORE UPDATE ON "customer_consent_events"
       FOR EACH ROW EXECUTE FUNCTION customer_consent_events_append_only()`,
    );

    // --- Fuzzy name matching (optional) -----------------------------------
    // pg_trgm is used for "similar name" duplicate detection when available;
    // without it the app falls back to exact normalised-name matching.
    await queryRunner.query(
      `DO $$
       BEGIN
         CREATE EXTENSION IF NOT EXISTS pg_trgm;
       EXCEPTION WHEN OTHERS THEN
         RAISE NOTICE 'pg_trgm not available: %', SQLERRM;
       END $$`,
    );
    await queryRunner.query(
      `DO $$
       BEGIN
         IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
           CREATE INDEX IF NOT EXISTS "IDX_customers_name_trgm" ON "customers"
             USING gin ((lower(btrim(coalesce("firstName", '') || ' ' || coalesce("lastName", '')))) gin_trgm_ops);
         END IF;
       END $$`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // pg_trgm is left installed: other features may rely on it
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_customers_name_trgm"`,
    );
    await queryRunner.query(
      `DROP TRIGGER IF EXISTS "TRG_customer_consent_events_append_only" ON "customer_consent_events"`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS customer_consent_events_append_only()`,
    );
    await queryRunner.query(`DROP TABLE "customer_consent_events"`);

    await queryRunner.query(`DROP INDEX "public"."IDX_customers_phone_norm"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_customers_email_norm"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_customers_group"`);
    await queryRunner.query(
      `ALTER TABLE "customers" DROP CONSTRAINT "FK_customers_merged_into"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" DROP CONSTRAINT "FK_customers_group"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" DROP COLUMN "mergedIntoId"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" DROP COLUMN "consentSource"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" DROP COLUMN "consentUpdatedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" DROP COLUMN "marketingSmsConsent"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" DROP COLUMN "marketingEmailConsent"`,
    );
    await queryRunner.query(`ALTER TABLE "customers" DROP COLUMN "groupId"`);

    await queryRunner.query(`DROP TABLE "customer_field_definitions"`);
    await queryRunner.query(
      `DROP TYPE "public"."customer_field_definitions_fieldtype_enum"`,
    );
    await queryRunner.query(`DROP TABLE "customer_groups"`);

    // Longer URLs would not fit back into 255 characters
    await queryRunner.query(
      `UPDATE "product_variants" SET "imageUrl" = NULL WHERE length("imageUrl") > 255`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ALTER COLUMN "imageUrl" TYPE character varying(255)`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP COLUMN "variantAttributes"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP COLUMN "sizeBytes"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP COLUMN "contentType"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP COLUMN "storageKey"`,
    );
  }
}
