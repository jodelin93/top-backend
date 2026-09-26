import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCoreEntities1790259603121 implements MigrationInterface {
  name = 'AddCoreEntities1790259603121';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "categories" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" jsonb NOT NULL, "description" jsonb, "parentId" uuid, "sortOrder" integer NOT NULL DEFAULT '0', "isActive" boolean NOT NULL DEFAULT true, "imageUrl" character varying(255), "mpath" character varying DEFAULT '', "tenant_id" uuid, CONSTRAINT "uq_category_id_tenant" UNIQUE ("id", "tenantId"), CONSTRAINT "uq_category_code" UNIQUE ("tenantId", "code"), CONSTRAINT "PK_24dbc6126a28ff948da33e97d3b" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_46a85229c9953b2b94f768190b" ON "categories"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."products_producttype_enum" AS ENUM('simple', 'variable', 'composite')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."products_status_enum" AS ENUM('active', 'inactive', 'discontinued')`,
    );
    await queryRunner.query(
      `CREATE TABLE "products" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL DEFAULT '1', "tenantId" uuid NOT NULL, "sku" character varying(100) NOT NULL, "name" jsonb NOT NULL, "description" jsonb, "productType" "public"."products_producttype_enum" NOT NULL DEFAULT 'simple', "categoryId" uuid, "brand" character varying(50), "manufacturer" character varying(50), "barcode" character varying(100), "isSerialized" boolean NOT NULL DEFAULT true, "isBatchTracked" boolean NOT NULL DEFAULT false, "allowBackorder" boolean NOT NULL DEFAULT true, "minStockLevel" integer, "maxStockLevel" integer, "reorderPoint" integer, "reorderQuantity" integer, "weight" numeric(10,4), "weightUnit" character varying(10), "length" numeric(10,2), "width" numeric(10,2), "height" numeric(10,2), "dimensionUnit" character varying(10), "metadata" jsonb NOT NULL DEFAULT '{}', "status" "public"."products_status_enum" NOT NULL DEFAULT 'active', "tenant_id" uuid, "category_id" uuid, CONSTRAINT "uq_product_id_tenant" UNIQUE ("id", "tenantId"), CONSTRAINT "uq_product_sku" UNIQUE ("tenantId", "sku"), CONSTRAINT "PK_0806c755e0aca124e67c0cf6d7d" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_db9b762961039d7c9f0cffc365" ON "products"  ("productType") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_ff56834e735fa78a15d0cf2192" ON "products"  ("categoryId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6804855ba1a19523ea57e0769b" ON "products"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."product_variants_status_enum" AS ENUM('active', 'inactive', 'discontinued')`,
    );
    await queryRunner.query(
      `CREATE TABLE "product_variants" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL DEFAULT '1', "tenantId" uuid NOT NULL, "productId" uuid NOT NULL, "sku" character varying(100) NOT NULL, "barcode" character varying(100), "name" jsonb, "cost" numeric(19,4), "price" numeric(19,4), "compareAtPrice" numeric(19,4), "stockQuantity" integer NOT NULL DEFAULT '0', "reservedQuantity" integer, "minStockLevel" integer, "maxStockLevel" integer, "weight" numeric(10,4), "weightUnit" character varying(10), "imageUrl" character varying(255), "sortOrder" integer NOT NULL DEFAULT '0', "metadata" jsonb NOT NULL DEFAULT '{}', "status" "public"."product_variants_status_enum" NOT NULL DEFAULT 'active', "tenant_id" uuid, "product_id" uuid, CONSTRAINT "uq_variant_id_tenant" UNIQUE ("id", "tenantId"), CONSTRAINT "uq_variant_sku" UNIQUE ("tenantId", "sku"), CONSTRAINT "PK_281e3f2c55652d6a22c0aa59fd7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_62124a7ca2686cbaed42f0d3a2" ON "product_variants"  ("barcode") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f515690c571a03400a9876600b" ON "product_variants"  ("productId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cb549293071d118e0d19a89eb2" ON "product_variants"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "attribute_values" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "variantId" uuid NOT NULL, "attributeId" uuid NOT NULL, "value" text NOT NULL, "tenant_id" uuid, "variant_id" uuid, "attribute_id" uuid, CONSTRAINT "uq_attribute_variant" UNIQUE ("variantId", "attributeId"), CONSTRAINT "PK_3babf93d1842d73e7ba849c0160" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b8f8e1d9141248b538c9285574" ON "attribute_values"  ("attributeId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1cd3b57e5242141a8bd0f31567" ON "attribute_values"  ("variantId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_41b39e922cbfe5d74ef088531f" ON "attribute_values"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."attribute_definitions_attributetype_enum" AS ENUM('text', 'number', 'boolean', 'select', 'multiselect', 'color')`,
    );
    await queryRunner.query(
      `CREATE TABLE "attribute_definitions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" jsonb NOT NULL, "attributeType" "public"."attribute_definitions_attributetype_enum" NOT NULL, "options" jsonb, "isRequired" boolean NOT NULL DEFAULT false, "isVariantDefining" boolean NOT NULL DEFAULT false, "sortOrder" integer NOT NULL DEFAULT '0', "tenant_id" uuid, CONSTRAINT "uq_attribute_id_tenant" UNIQUE ("id", "tenantId"), CONSTRAINT "uq_attribute_code" UNIQUE ("tenantId", "code"), CONSTRAINT "PK_0430dd4f09c3ff09daa16484676" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_a1d344b5c8c15f564d099f6bec" ON "attribute_definitions"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "sale_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "saleId" uuid NOT NULL, "variantId" uuid NOT NULL, "sku" character varying(100) NOT NULL, "productName" character varying(255) NOT NULL, "variantName" character varying(255), "quantity" integer NOT NULL, "unitPrice" numeric(19,4) NOT NULL, "subtotal" numeric(19,4) NOT NULL, "discountAmount" numeric(19,4) NOT NULL DEFAULT '0', "taxAmount" numeric(19,4) NOT NULL DEFAULT '0', "total" numeric(19,4) NOT NULL, "cost" numeric(19,4), "notes" character varying(255), "metadata" jsonb NOT NULL DEFAULT '{}', "lineNumber" integer NOT NULL DEFAULT '0', "tenant_id" uuid, "sale_id" uuid, "variant_id" uuid, CONSTRAINT "PK_5a7dc5b4562a9e590528b3e08ab" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_680af2649290bfb88bcff7e695" ON "sale_items"  ("variantId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c642be08de5235317d4cf3deb4" ON "sale_items"  ("saleId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_59bf1a657943f7ba75eeef920e" ON "sale_items"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payment_methods_methodtype_enum" AS ENUM('cash', 'card', 'mobile', 'bank_transfer', 'check', 'store_credit', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payment_methods_status_enum" AS ENUM('active', 'inactive')`,
    );
    await queryRunner.query(
      `CREATE TABLE "payment_methods" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" jsonb NOT NULL, "methodType" "public"."payment_methods_methodtype_enum" NOT NULL, "requiresReference" boolean NOT NULL DEFAULT false, "opensDrawer" boolean NOT NULL DEFAULT true, "settings" jsonb NOT NULL DEFAULT '{}', "status" "public"."payment_methods_status_enum" NOT NULL DEFAULT 'active', "tenant_id" uuid, CONSTRAINT "uq_payment_method_code" UNIQUE ("tenantId", "code"), CONSTRAINT "PK_34f9b8c6dfb4ac3559f7e2820d1" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5806b0d1820c6ae8c880ca4204" ON "payment_methods"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."payments_status_enum" AS ENUM('pending', 'completed', 'failed', 'refunded')`,
    );
    await queryRunner.query(
      `CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "saleId" uuid NOT NULL, "paymentMethodId" uuid NOT NULL, "amount" numeric(19,4) NOT NULL, "currencyCode" character(3) NOT NULL, "paymentDate" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "reference" character varying(255), "notes" character varying(255), "metadata" jsonb NOT NULL DEFAULT '{}', "status" "public"."payments_status_enum" NOT NULL DEFAULT 'completed', "idempotencyKey" character varying(100), "tenant_id" uuid, "sale_id" uuid, "payment_method_id" uuid, CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_27faf14e8959f0e40d7b722dc0" ON "payments"  ("paymentDate") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_32b41cdb985a296213e9a928b5" ON "payments"  ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_cbe18cae039006a9c217d5a66a" ON "payments"  ("paymentMethodId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_e15427928c7a02bd304d628c41" ON "payments"  ("saleId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_98a04cdcbac4f6a2c55c7d1935" ON "payments"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."sales_saletype_enum" AS ENUM('regular', 'return', 'exchange')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."sales_status_enum" AS ENUM('draft', 'completed', 'voided', 'refunded', 'partially_refunded')`,
    );
    await queryRunner.query(
      `CREATE TABLE "sales" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL DEFAULT '1', "tenantId" uuid NOT NULL, "saleNumber" character varying(50) NOT NULL, "branchId" uuid NOT NULL, "registerId" uuid NOT NULL, "customerId" uuid, "userId" uuid NOT NULL, "saleType" "public"."sales_saletype_enum" NOT NULL DEFAULT 'regular', "saleDate" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "subtotal" numeric(19,4) NOT NULL, "taxAmount" numeric(19,4) NOT NULL DEFAULT '0', "discountAmount" numeric(19,4) NOT NULL DEFAULT '0', "total" numeric(19,4) NOT NULL, "amountPaid" numeric(19,4) NOT NULL DEFAULT '0', "changeAmount" numeric(19,4) NOT NULL DEFAULT '0', "currencyCode" character(3) NOT NULL, "notes" character varying(255), "metadata" jsonb NOT NULL DEFAULT '{}', "status" "public"."sales_status_enum" NOT NULL DEFAULT 'draft', "parentSaleId" uuid, "idempotencyKey" character varying(100), "tenant_id" uuid, "branch_id" uuid, "register_id" uuid, "customer_id" uuid, "user_id" uuid, "parent_sale_id" uuid, CONSTRAINT "uq_sale_id_tenant" UNIQUE ("id", "tenantId"), CONSTRAINT "uq_sale_number" UNIQUE ("tenantId", "saleNumber"), CONSTRAINT "PK_4f0bc990ae81dba46da680895ea" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_65f3c52de52446c1d23ed5daf2" ON "sales"  ("saleDate") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_83e1f4b8d3b863cce4846e0295" ON "sales"  ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3a92cf6add00043cef9833db1c" ON "sales"  ("customerId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_4bc54d6ef4124246ab60cf1e0b" ON "sales"  ("registerId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3025cd80c0a8de190072940e10" ON "sales"  ("branchId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_37606c7b1560c6be428c7a4895" ON "sales"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."customers_customertype_enum" AS ENUM('individual', 'business')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."customers_status_enum" AS ENUM('active', 'inactive', 'blocked')`,
    );
    await queryRunner.query(
      `CREATE TABLE "customers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "code" character varying(50) NOT NULL, "customerType" "public"."customers_customertype_enum" NOT NULL DEFAULT 'individual', "firstName" character varying(255), "lastName" character varying(255), "companyName" character varying(255), "email" character varying(255), "phone" character varying(50), "taxNumber" character varying(100), "dateOfBirth" date, "locale" character varying(10), "creditLimit" numeric(19,4) NOT NULL DEFAULT '0', "currentBalance" numeric(19,4) NOT NULL DEFAULT '0', "loyaltyPoints" integer NOT NULL DEFAULT '0', "metadata" jsonb NOT NULL DEFAULT '{}', "status" "public"."customers_status_enum" NOT NULL DEFAULT 'active', "lastPurchaseAt" TIMESTAMP WITH TIME ZONE, "tenant_id" uuid, CONSTRAINT "uq_customer_code" UNIQUE ("tenantId", "code"), CONSTRAINT "PK_133ec679a801fab5e070f73d3ea" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_88acd889fbe17d0e16cc4bc917" ON "customers"  ("phone") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8536b8b85c06969f84f0c098b0" ON "customers"  ("email") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_37c1a605468d156e6a8f78f1dc" ON "customers"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."discounts_discounttype_enum" AS ENUM('percentage', 'fixed_amount', 'buy_x_get_y')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."discounts_scope_enum" AS ENUM('product', 'category', 'cart')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."discounts_status_enum" AS ENUM('active', 'inactive', 'scheduled', 'expired')`,
    );
    await queryRunner.query(
      `CREATE TABLE "discounts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" jsonb NOT NULL, "description" jsonb, "discountType" "public"."discounts_discounttype_enum" NOT NULL, "scope" "public"."discounts_scope_enum" NOT NULL, "value" numeric(19,4), "percentage" numeric(5,2), "buyQuantity" integer, "getQuantity" integer, "minPurchaseAmount" numeric(19,4), "maxDiscountAmount" numeric(19,4), "usageLimit" integer, "usageCount" integer NOT NULL DEFAULT '0', "usageLimitPerCustomer" integer, "validFrom" TIMESTAMP WITH TIME ZONE, "validTo" TIMESTAMP WITH TIME ZONE, "applicableProductIds" jsonb NOT NULL DEFAULT '[]', "applicableCategoryIds" jsonb NOT NULL DEFAULT '[]', "excludedProductIds" jsonb NOT NULL DEFAULT '[]', "priority" integer NOT NULL DEFAULT '0', "status" "public"."discounts_status_enum" NOT NULL DEFAULT 'active', "tenant_id" uuid, CONSTRAINT "uq_discount_code" UNIQUE ("tenantId", "code"), CONSTRAINT "PK_66c522004212dc814d6e2f14ecc" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0c840b43e501d5b8b9a43bd516" ON "discounts"  ("validTo") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_bc0aac7b85315e6b950daf0ffa" ON "discounts"  ("validFrom") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_24d6bf275636ebbe97a916fc1e" ON "discounts"  ("scope") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_eeaeeb128b5903372636b1c3bf" ON "discounts"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."price_lists_pricelisttype_enum" AS ENUM('standard', 'promotional', 'wholesale', 'member')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."price_lists_status_enum" AS ENUM('active', 'inactive', 'scheduled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "price_lists" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" jsonb NOT NULL, "description" jsonb, "priceListType" "public"."price_lists_pricelisttype_enum" NOT NULL DEFAULT 'standard', "currencyCode" character(3) NOT NULL, "branchId" uuid, "validFrom" TIMESTAMP WITH TIME ZONE, "validTo" TIMESTAMP WITH TIME ZONE, "priority" integer NOT NULL DEFAULT '0', "status" "public"."price_lists_status_enum" NOT NULL DEFAULT 'active', "tenant_id" uuid, "branch_id" uuid, CONSTRAINT "uq_pricelist_id_tenant" UNIQUE ("id", "tenantId"), CONSTRAINT "uq_pricelist_code" UNIQUE ("tenantId", "code"), CONSTRAINT "PK_fd66ee20b065696da25c97fa45a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_31b210a096ef49b460258ecb70" ON "price_lists"  ("branchId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_02d8838ac5cd6133a7fff466f4" ON "price_lists"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "price_entries" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "priceListId" uuid NOT NULL, "variantId" uuid NOT NULL, "price" numeric(19,4) NOT NULL, "compareAtPrice" numeric(19,4), "cost" numeric(19,4), "minQuantity" integer, "maxQuantity" integer, "validFrom" TIMESTAMP WITH TIME ZONE, "validTo" TIMESTAMP WITH TIME ZONE, "tenant_id" uuid, "price_list_id" uuid, "variant_id" uuid, CONSTRAINT "uq_price_variant" UNIQUE ("priceListId", "variantId"), CONSTRAINT "PK_98b06279277ae9458f9f6c75f74" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_11b6eed4fa8b428783eb249741" ON "price_entries"  ("variantId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_faef09ccb9328a55f3a4e1e785" ON "price_entries"  ("priceListId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_73c3ae7a509e6f16989d05c3cf" ON "price_entries"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "product_images" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "productId" uuid NOT NULL, "url" character varying(500) NOT NULL, "altText" character varying(255), "sortOrder" integer NOT NULL DEFAULT '0', "isPrimary" boolean NOT NULL DEFAULT false, "tenant_id" uuid, "product_id" uuid, CONSTRAINT "PK_1974264ea7265989af8392f63a1" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b367708bf720c8dd62fc683316" ON "product_images"  ("productId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_afd3202e7e6d23df6660dca2ac" ON "product_images"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."suppliers_status_enum" AS ENUM('active', 'inactive', 'blocked')`,
    );
    await queryRunner.query(
      `CREATE TABLE "suppliers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" character varying(255) NOT NULL, "contactPerson" character varying(255), "email" character varying(255), "phone" character varying(50), "addressLine1" character varying(255), "addressLine2" character varying(255), "city" character varying(100), "stateProvince" character varying(100), "postalCode" character varying(20), "countryCode" character(2), "taxNumber" character varying(100), "paymentTermDays" integer, "metadata" jsonb NOT NULL DEFAULT '{}', "status" "public"."suppliers_status_enum" NOT NULL DEFAULT 'active', "tenant_id" uuid, CONSTRAINT "uq_supplier_code" UNIQUE ("tenantId", "code"), CONSTRAINT "PK_b70ac51766a9e3144f778cfe81e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_66181e465a65c2ddcfa9c00c9c" ON "suppliers"  ("email") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_dd5cd678c4e94ddb93a224e711" ON "suppliers"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."purchase_orders_status_enum" AS ENUM('draft', 'pending', 'approved', 'ordered', 'partially_received', 'received', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "purchase_orders" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL DEFAULT '1', "tenantId" uuid NOT NULL, "poNumber" character varying(50) NOT NULL, "supplierId" uuid NOT NULL, "warehouseId" uuid NOT NULL, "orderDate" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "expectedDeliveryDate" TIMESTAMP WITH TIME ZONE, "subtotal" numeric(19,4) NOT NULL, "taxAmount" numeric(19,4) NOT NULL DEFAULT '0', "shippingCost" numeric(19,4) NOT NULL DEFAULT '0', "total" numeric(19,4) NOT NULL, "currencyCode" character(3) NOT NULL, "userId" uuid NOT NULL, "notes" character varying(500), "status" "public"."purchase_orders_status_enum" NOT NULL DEFAULT 'draft', "tenant_id" uuid, "supplier_id" uuid, "warehouse_id" uuid, "user_id" uuid, CONSTRAINT "uq_po_id_tenant" UNIQUE ("id", "tenantId"), CONSTRAINT "uq_po_number" UNIQUE ("tenantId", "poNumber"), CONSTRAINT "PK_05148947415204a897e8beb2553" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_8be43e7dd0ae89d236418c690c" ON "purchase_orders"  ("orderDate") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5272ac3aa931eedb14cd8789d6" ON "purchase_orders"  ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f52c798da22c916be5a9e7ac15" ON "purchase_orders"  ("warehouseId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0c3ff892a9f2ed16f59d31ccca" ON "purchase_orders"  ("supplierId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_299ed1b81cad44317acbf02bab" ON "purchase_orders"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "purchase_order_items" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "purchaseOrderId" uuid NOT NULL, "variantId" uuid NOT NULL, "sku" character varying(100) NOT NULL, "productName" character varying(255) NOT NULL, "quantityOrdered" integer NOT NULL, "quantityReceived" integer NOT NULL DEFAULT '0', "unitCost" numeric(19,4) NOT NULL, "subtotal" numeric(19,4) NOT NULL, "taxAmount" numeric(19,4) NOT NULL DEFAULT '0', "total" numeric(19,4) NOT NULL, "notes" character varying(255), "lineNumber" integer NOT NULL DEFAULT '0', "tenant_id" uuid, "purchase_order_id" uuid, "variant_id" uuid, CONSTRAINT "PK_e8b7568d25c41e3290db596b312" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_6358f2da3da086955aab0f4f3b" ON "purchase_order_items"  ("variantId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1de7eb246940b05765d2c99a7e" ON "purchase_order_items"  ("purchaseOrderId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_1e46ec8256e97336689eacbaaa" ON "purchase_order_items"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_adjustments_reason_enum" AS ENUM('recount', 'damage', 'theft', 'expiry', 'other')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_adjustments_status_enum" AS ENUM('draft', 'completed', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TABLE "stock_adjustments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "adjustmentNumber" character varying(50) NOT NULL, "locationId" uuid NOT NULL, "reason" "public"."stock_adjustments_reason_enum" NOT NULL, "adjustmentDate" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "userId" uuid NOT NULL, "notes" character varying(500), "status" "public"."stock_adjustments_status_enum" NOT NULL DEFAULT 'draft', "tenant_id" uuid, "location_id" uuid, "user_id" uuid, CONSTRAINT "uq_adjustment_number" UNIQUE ("tenantId", "adjustmentNumber"), CONSTRAINT "PK_7dc03d92f242dd489d33b80d063" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_45080b47646b52ab371e4bf001" ON "stock_adjustments"  ("status") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_c4c1207649fd0ff28d394db8c9" ON "stock_adjustments"  ("locationId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_20404b71a1380c6083dcf76e7d" ON "stock_adjustments"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TABLE "stock_levels" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "version" integer NOT NULL DEFAULT '1', "tenantId" uuid NOT NULL, "variantId" uuid NOT NULL, "locationId" uuid NOT NULL, "quantityOnHand" integer NOT NULL DEFAULT '0', "quantityReserved" integer NOT NULL DEFAULT '0', "quantityAvailable" integer NOT NULL DEFAULT '0', "quantityInTransit" integer NOT NULL DEFAULT '0', "lastCountedAt" TIMESTAMP WITH TIME ZONE, "lastReceivedAt" TIMESTAMP WITH TIME ZONE, "tenant_id" uuid, "variant_id" uuid, "location_id" uuid, CONSTRAINT "uq_stock_variant_location" UNIQUE ("variantId", "locationId"), CONSTRAINT "PK_ee416fdf2f5696dff16fd0c1c90" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_5f268ba6658e075c5172c108fa" ON "stock_levels"  ("locationId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_382b617b6109816b300db459bc" ON "stock_levels"  ("variantId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7aa2d853d19f3df3a890aa791f" ON "stock_levels"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."stock_movements_movementtype_enum" AS ENUM('sale', 'purchase', 'adjustment', 'transfer', 'return', 'damage', 'theft', 'recount')`,
    );
    await queryRunner.query(
      `CREATE TABLE "stock_movements" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "variantId" uuid NOT NULL, "fromLocationId" uuid, "toLocationId" uuid, "movementType" "public"."stock_movements_movementtype_enum" NOT NULL, "quantity" integer NOT NULL, "movementDate" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "referenceType" character varying(50), "referenceId" uuid, "referenceNumber" character varying(50), "cost" numeric(19,4), "userId" uuid NOT NULL, "notes" character varying(500), "metadata" jsonb NOT NULL DEFAULT '{}', "tenant_id" uuid, "variant_id" uuid, "from_location_id" uuid, "to_location_id" uuid, "user_id" uuid, CONSTRAINT "PK_57a26b190618550d8e65fb860e7" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_17e3734d294fe84a440c9f304d" ON "stock_movements"  ("referenceType", "referenceId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b9ab4db6fbe12384c8f7e6eb30" ON "stock_movements"  ("movementDate") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_591aca148f00fd61c720c81424" ON "stock_movements"  ("movementType") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_0e0d11c63ba05a1cca96cf2944" ON "stock_movements"  ("toLocationId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7439fd5af587c465d301664224" ON "stock_movements"  ("fromLocationId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_b1e10f38c51868fba8bac1e12c" ON "stock_movements"  ("variantId") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_7dde280faf0d06b5b1b067b8ac" ON "stock_movements"  ("tenantId") `,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."tax_rates_taxtype_enum" AS ENUM('percentage', 'fixed_amount')`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."tax_rates_status_enum" AS ENUM('active', 'inactive')`,
    );
    await queryRunner.query(
      `CREATE TABLE "tax_rates" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "tenantId" uuid NOT NULL, "code" character varying(50) NOT NULL, "name" jsonb NOT NULL, "taxType" "public"."tax_rates_taxtype_enum" NOT NULL DEFAULT 'percentage', "rate" numeric(5,2) NOT NULL, "countryCode" character(2), "stateProvince" character varying(100), "isCompound" boolean NOT NULL DEFAULT false, "isDefault" boolean NOT NULL DEFAULT true, "status" "public"."tax_rates_status_enum" NOT NULL DEFAULT 'active', "tenant_id" uuid, CONSTRAINT "uq_tax_code" UNIQUE ("tenantId", "code"), CONSTRAINT "PK_41164a748f3dafa373c7e508ca2" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3d3ffb2ccd12421f1bc249085c" ON "tax_rates"  ("countryCode") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_f3b8fedd11b19143dd32287b6a" ON "tax_rates"  ("tenantId") `,
    );
    await queryRunner.query(
      `ALTER TABLE "categories" ADD CONSTRAINT "FK_5d4fe23b360b1b9e16a3f41727f" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "categories" ADD CONSTRAINT "FK_9a6f051e66982b5f0318981bcaa" FOREIGN KEY ("parentId") REFERENCES "categories"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "FK_9c365ebf78f0e8a6d9e4827ea70" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" ADD CONSTRAINT "FK_860485c46a817f4b075a7a3265b" FOREIGN KEY ("category_id", "tenant_id") REFERENCES "categories"("id","tenantId") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD CONSTRAINT "FK_553196ea54b383f352401962af2" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" ADD CONSTRAINT "FK_631868eaa78af7cf2bd30b092e7" FOREIGN KEY ("product_id", "tenant_id") REFERENCES "products"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" ADD CONSTRAINT "FK_1105dbf21d189f0d5351331a989" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" ADD CONSTRAINT "FK_acbe2d50e7f46c0f06ac34ee819" FOREIGN KEY ("variant_id", "tenant_id") REFERENCES "product_variants"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" ADD CONSTRAINT "FK_6fc6f7c307e4bf07e08c5e4a9b0" FOREIGN KEY ("attribute_id", "tenant_id") REFERENCES "attribute_definitions"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_definitions" ADD CONSTRAINT "FK_7a18ded923b3ce8fde8338c2b31" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" ADD CONSTRAINT "FK_b1b3176b27d1190616e8ac02109" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" ADD CONSTRAINT "FK_e2eea482af20ddb49c8f9cfd710" FOREIGN KEY ("sale_id", "tenant_id") REFERENCES "sales"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" ADD CONSTRAINT "FK_ef13c0725838fde279f29831217" FOREIGN KEY ("variant_id", "tenant_id") REFERENCES "product_variants"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_methods" ADD CONSTRAINT "FK_e65eddc13f0cb1694ce740dc6b7" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_9109b53fca5cef7720aca72974d" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_778b09e1333bd4c0fd8aad37a73" FOREIGN KEY ("sale_id", "tenant_id") REFERENCES "sales"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD CONSTRAINT "FK_12fd861c33c885f01b9a7da7d93" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_ae6cc7812b56c7a03599a407d90" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_acd4c1095487898fdce94c3d31e" FOREIGN KEY ("branch_id", "tenant_id") REFERENCES "branches"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_2fcbd760528adf030fe3bf86416" FOREIGN KEY ("register_id") REFERENCES "registers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_c51005b2b06cec7aa17462c54f5" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_5f282f3656814ec9ca2675aef6f" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" ADD CONSTRAINT "FK_b5f573f9bb2f26179da6d6f7711" FOREIGN KEY ("parent_sale_id", "tenant_id") REFERENCES "sales"("id","tenantId") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" ADD CONSTRAINT "FK_97913f35ac2e435a4463fb50a01" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "discounts" ADD CONSTRAINT "FK_881f8f8ab71335fb8e3cd5703e9" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_lists" ADD CONSTRAINT "FK_35de7c0f11722fb48e2b09a466f" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_lists" ADD CONSTRAINT "FK_367e5805317457739acfb681551" FOREIGN KEY ("branch_id", "tenant_id") REFERENCES "branches"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" ADD CONSTRAINT "FK_97a9abbc5b4372cfb15efe9eb13" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" ADD CONSTRAINT "FK_545dca0ee9afd3f176ceab62e87" FOREIGN KEY ("price_list_id", "tenant_id") REFERENCES "price_lists"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" ADD CONSTRAINT "FK_cecef093f501fe692704f23f370" FOREIGN KEY ("variant_id", "tenant_id") REFERENCES "product_variants"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" ADD CONSTRAINT "FK_866b999f190dfdec5a077e1abc5" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" ADD CONSTRAINT "FK_42e03e8288b4c27af35dcd4b1c9" FOREIGN KEY ("product_id", "tenant_id") REFERENCES "products"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "suppliers" ADD CONSTRAINT "FK_b0d0350059126fa08fddc3c7a46" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD CONSTRAINT "FK_237678c98436e0abb48b3060c82" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD CONSTRAINT "FK_d16a885aa88447ccfd010e739b0" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD CONSTRAINT "FK_4deb35e7eb5f6002a09dc43d9c6" FOREIGN KEY ("warehouse_id", "tenant_id") REFERENCES "warehouses"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD CONSTRAINT "FK_c13036093717212c2c6aa111c73" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" ADD CONSTRAINT "FK_0f5b7d10c33fd6432f7b2636045" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" ADD CONSTRAINT "FK_00cb491bb39ad41fdd0863f0475" FOREIGN KEY ("purchase_order_id", "tenant_id") REFERENCES "purchase_orders"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" ADD CONSTRAINT "FK_7c8982651b3e47e1c30dc1457d3" FOREIGN KEY ("variant_id", "tenant_id") REFERENCES "product_variants"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" ADD CONSTRAINT "FK_f88dacd92b4cc8d5a48a8c19994" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" ADD CONSTRAINT "FK_27a1a2048d35e2bbe421f302e33" FOREIGN KEY ("location_id", "tenant_id") REFERENCES "inventory_locations"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" ADD CONSTRAINT "FK_a6e8e9bb147339f4bb77147863b" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" ADD CONSTRAINT "FK_703e27532235de1937132c8ab47" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" ADD CONSTRAINT "FK_fbf4e99328422e7a889c06a7016" FOREIGN KEY ("variant_id", "tenant_id") REFERENCES "product_variants"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" ADD CONSTRAINT "FK_232c2100e981260bf8ca5a98773" FOREIGN KEY ("location_id", "tenant_id") REFERENCES "inventory_locations"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_30dd9acc22dcb6ae51d7d34f16d" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_ede9170736a1fcf13d4c23792a1" FOREIGN KEY ("variant_id", "tenant_id") REFERENCES "product_variants"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_011d2db0f22096952c6b3309c38" FOREIGN KEY ("from_location_id", "tenant_id") REFERENCES "inventory_locations"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_4a1e05185a0ffe45994c5d9dacd" FOREIGN KEY ("to_location_id", "tenant_id") REFERENCES "inventory_locations"("id","tenantId") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" ADD CONSTRAINT "FK_d7fedfd6ee0f4a06648c48631c6" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "tax_rates" ADD CONSTRAINT "FK_9675366aed16a56e6c9322805f4" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "tax_rates" DROP CONSTRAINT "FK_9675366aed16a56e6c9322805f4"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_d7fedfd6ee0f4a06648c48631c6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_4a1e05185a0ffe45994c5d9dacd"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_011d2db0f22096952c6b3309c38"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_ede9170736a1fcf13d4c23792a1"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_movements" DROP CONSTRAINT "FK_30dd9acc22dcb6ae51d7d34f16d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" DROP CONSTRAINT "FK_232c2100e981260bf8ca5a98773"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" DROP CONSTRAINT "FK_fbf4e99328422e7a889c06a7016"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_levels" DROP CONSTRAINT "FK_703e27532235de1937132c8ab47"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" DROP CONSTRAINT "FK_a6e8e9bb147339f4bb77147863b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" DROP CONSTRAINT "FK_27a1a2048d35e2bbe421f302e33"`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_adjustments" DROP CONSTRAINT "FK_f88dacd92b4cc8d5a48a8c19994"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" DROP CONSTRAINT "FK_7c8982651b3e47e1c30dc1457d3"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" DROP CONSTRAINT "FK_00cb491bb39ad41fdd0863f0475"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_order_items" DROP CONSTRAINT "FK_0f5b7d10c33fd6432f7b2636045"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP CONSTRAINT "FK_c13036093717212c2c6aa111c73"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP CONSTRAINT "FK_4deb35e7eb5f6002a09dc43d9c6"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP CONSTRAINT "FK_d16a885aa88447ccfd010e739b0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP CONSTRAINT "FK_237678c98436e0abb48b3060c82"`,
    );
    await queryRunner.query(
      `ALTER TABLE "suppliers" DROP CONSTRAINT "FK_b0d0350059126fa08fddc3c7a46"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP CONSTRAINT "FK_42e03e8288b4c27af35dcd4b1c9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_images" DROP CONSTRAINT "FK_866b999f190dfdec5a077e1abc5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" DROP CONSTRAINT "FK_cecef093f501fe692704f23f370"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" DROP CONSTRAINT "FK_545dca0ee9afd3f176ceab62e87"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_entries" DROP CONSTRAINT "FK_97a9abbc5b4372cfb15efe9eb13"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_lists" DROP CONSTRAINT "FK_367e5805317457739acfb681551"`,
    );
    await queryRunner.query(
      `ALTER TABLE "price_lists" DROP CONSTRAINT "FK_35de7c0f11722fb48e2b09a466f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "discounts" DROP CONSTRAINT "FK_881f8f8ab71335fb8e3cd5703e9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "customers" DROP CONSTRAINT "FK_97913f35ac2e435a4463fb50a01"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_b5f573f9bb2f26179da6d6f7711"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_5f282f3656814ec9ca2675aef6f"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_c51005b2b06cec7aa17462c54f5"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_2fcbd760528adf030fe3bf86416"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_acd4c1095487898fdce94c3d31e"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sales" DROP CONSTRAINT "FK_ae6cc7812b56c7a03599a407d90"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_12fd861c33c885f01b9a7da7d93"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_778b09e1333bd4c0fd8aad37a73"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP CONSTRAINT "FK_9109b53fca5cef7720aca72974d"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payment_methods" DROP CONSTRAINT "FK_e65eddc13f0cb1694ce740dc6b7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" DROP CONSTRAINT "FK_ef13c0725838fde279f29831217"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" DROP CONSTRAINT "FK_e2eea482af20ddb49c8f9cfd710"`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_items" DROP CONSTRAINT "FK_b1b3176b27d1190616e8ac02109"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_definitions" DROP CONSTRAINT "FK_7a18ded923b3ce8fde8338c2b31"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" DROP CONSTRAINT "FK_6fc6f7c307e4bf07e08c5e4a9b0"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" DROP CONSTRAINT "FK_acbe2d50e7f46c0f06ac34ee819"`,
    );
    await queryRunner.query(
      `ALTER TABLE "attribute_values" DROP CONSTRAINT "FK_1105dbf21d189f0d5351331a989"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP CONSTRAINT "FK_631868eaa78af7cf2bd30b092e7"`,
    );
    await queryRunner.query(
      `ALTER TABLE "product_variants" DROP CONSTRAINT "FK_553196ea54b383f352401962af2"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT "FK_860485c46a817f4b075a7a3265b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "products" DROP CONSTRAINT "FK_9c365ebf78f0e8a6d9e4827ea70"`,
    );
    await queryRunner.query(
      `ALTER TABLE "categories" DROP CONSTRAINT "FK_9a6f051e66982b5f0318981bcaa"`,
    );
    await queryRunner.query(
      `ALTER TABLE "categories" DROP CONSTRAINT "FK_5d4fe23b360b1b9e16a3f41727f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f3b8fedd11b19143dd32287b6a"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3d3ffb2ccd12421f1bc249085c"`,
    );
    await queryRunner.query(`DROP TABLE "tax_rates"`);
    await queryRunner.query(`DROP TYPE "public"."tax_rates_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."tax_rates_taxtype_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7dde280faf0d06b5b1b067b8ac"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b1e10f38c51868fba8bac1e12c"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7439fd5af587c465d301664224"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0e0d11c63ba05a1cca96cf2944"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_591aca148f00fd61c720c81424"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b9ab4db6fbe12384c8f7e6eb30"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_17e3734d294fe84a440c9f304d"`,
    );
    await queryRunner.query(`DROP TABLE "stock_movements"`);
    await queryRunner.query(
      `DROP TYPE "public"."stock_movements_movementtype_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_7aa2d853d19f3df3a890aa791f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_382b617b6109816b300db459bc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5f268ba6658e075c5172c108fa"`,
    );
    await queryRunner.query(`DROP TABLE "stock_levels"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_20404b71a1380c6083dcf76e7d"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_c4c1207649fd0ff28d394db8c9"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_45080b47646b52ab371e4bf001"`,
    );
    await queryRunner.query(`DROP TABLE "stock_adjustments"`);
    await queryRunner.query(
      `DROP TYPE "public"."stock_adjustments_status_enum"`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."stock_adjustments_reason_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1e46ec8256e97336689eacbaaa"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1de7eb246940b05765d2c99a7e"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_6358f2da3da086955aab0f4f3b"`,
    );
    await queryRunner.query(`DROP TABLE "purchase_order_items"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_299ed1b81cad44317acbf02bab"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0c3ff892a9f2ed16f59d31ccca"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f52c798da22c916be5a9e7ac15"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5272ac3aa931eedb14cd8789d6"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8be43e7dd0ae89d236418c690c"`,
    );
    await queryRunner.query(`DROP TABLE "purchase_orders"`);
    await queryRunner.query(`DROP TYPE "public"."purchase_orders_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_dd5cd678c4e94ddb93a224e711"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_66181e465a65c2ddcfa9c00c9c"`,
    );
    await queryRunner.query(`DROP TABLE "suppliers"`);
    await queryRunner.query(`DROP TYPE "public"."suppliers_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_afd3202e7e6d23df6660dca2ac"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b367708bf720c8dd62fc683316"`,
    );
    await queryRunner.query(`DROP TABLE "product_images"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_73c3ae7a509e6f16989d05c3cf"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_faef09ccb9328a55f3a4e1e785"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_11b6eed4fa8b428783eb249741"`,
    );
    await queryRunner.query(`DROP TABLE "price_entries"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_02d8838ac5cd6133a7fff466f4"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_31b210a096ef49b460258ecb70"`,
    );
    await queryRunner.query(`DROP TABLE "price_lists"`);
    await queryRunner.query(`DROP TYPE "public"."price_lists_status_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."price_lists_pricelisttype_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_eeaeeb128b5903372636b1c3bf"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_24d6bf275636ebbe97a916fc1e"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_bc0aac7b85315e6b950daf0ffa"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_0c840b43e501d5b8b9a43bd516"`,
    );
    await queryRunner.query(`DROP TABLE "discounts"`);
    await queryRunner.query(`DROP TYPE "public"."discounts_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."discounts_scope_enum"`);
    await queryRunner.query(`DROP TYPE "public"."discounts_discounttype_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_37c1a605468d156e6a8f78f1dc"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_8536b8b85c06969f84f0c098b0"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_88acd889fbe17d0e16cc4bc917"`,
    );
    await queryRunner.query(`DROP TABLE "customers"`);
    await queryRunner.query(`DROP TYPE "public"."customers_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."customers_customertype_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_37606c7b1560c6be428c7a4895"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3025cd80c0a8de190072940e10"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_4bc54d6ef4124246ab60cf1e0b"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3a92cf6add00043cef9833db1c"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_83e1f4b8d3b863cce4846e0295"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_65f3c52de52446c1d23ed5daf2"`,
    );
    await queryRunner.query(`DROP TABLE "sales"`);
    await queryRunner.query(`DROP TYPE "public"."sales_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."sales_saletype_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_98a04cdcbac4f6a2c55c7d1935"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_e15427928c7a02bd304d628c41"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_cbe18cae039006a9c217d5a66a"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_32b41cdb985a296213e9a928b5"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_27faf14e8959f0e40d7b722dc0"`,
    );
    await queryRunner.query(`DROP TABLE "payments"`);
    await queryRunner.query(`DROP TYPE "public"."payments_status_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5806b0d1820c6ae8c880ca4204"`,
    );
    await queryRunner.query(`DROP TABLE "payment_methods"`);
    await queryRunner.query(`DROP TYPE "public"."payment_methods_status_enum"`);
    await queryRunner.query(
      `DROP TYPE "public"."payment_methods_methodtype_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_59bf1a657943f7ba75eeef920e"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_c642be08de5235317d4cf3deb4"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_680af2649290bfb88bcff7e695"`,
    );
    await queryRunner.query(`DROP TABLE "sale_items"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_a1d344b5c8c15f564d099f6bec"`,
    );
    await queryRunner.query(`DROP TABLE "attribute_definitions"`);
    await queryRunner.query(
      `DROP TYPE "public"."attribute_definitions_attributetype_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_41b39e922cbfe5d74ef088531f"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_1cd3b57e5242141a8bd0f31567"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_b8f8e1d9141248b538c9285574"`,
    );
    await queryRunner.query(`DROP TABLE "attribute_values"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_cb549293071d118e0d19a89eb2"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f515690c571a03400a9876600b"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_62124a7ca2686cbaed42f0d3a2"`,
    );
    await queryRunner.query(`DROP TABLE "product_variants"`);
    await queryRunner.query(
      `DROP TYPE "public"."product_variants_status_enum"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_6804855ba1a19523ea57e0769b"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_ff56834e735fa78a15d0cf2192"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_db9b762961039d7c9f0cffc365"`,
    );
    await queryRunner.query(`DROP TABLE "products"`);
    await queryRunner.query(`DROP TYPE "public"."products_status_enum"`);
    await queryRunner.query(`DROP TYPE "public"."products_producttype_enum"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_46a85229c9953b2b94f768190b"`,
    );
    await queryRunner.query(`DROP TABLE "categories"`);
  }
}
