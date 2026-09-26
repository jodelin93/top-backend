import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stock reservations with expiry (R063): stock held for held carts / orders.
 * Active reservations count towards stock_levels.quantityReserved.
 */
export class AddStockReservations1790302000000 implements MigrationInterface {
  name = 'AddStockReservations1790302000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."stock_reservations_status_enum" AS ENUM('active', 'released', 'committed', 'expired')`,
    );
    await queryRunner.query(`
      CREATE TABLE "stock_reservations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "variantId" uuid NOT NULL,
        "locationId" uuid NOT NULL,
        "quantity" integer NOT NULL,
        "referenceType" character varying(50) NOT NULL,
        "referenceId" character varying(100) NOT NULL,
        "expiresAt" TIMESTAMP WITH TIME ZONE,
        "status" "public"."stock_reservations_status_enum" NOT NULL DEFAULT 'active',
        "closedAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_stock_reservations" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_stock_reservations_tenant" ON "stock_reservations" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_stock_reservations_reference" ON "stock_reservations" ("tenantId", "referenceType", "referenceId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_stock_reservations_level" ON "stock_reservations" ("variantId", "locationId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_stock_reservations_active_expiry" ON "stock_reservations" ("expiresAt") WHERE "status" = 'active'`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_reservations" ADD CONSTRAINT "fk_stock_reservations_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_reservations" ADD CONSTRAINT "fk_stock_reservations_variant" FOREIGN KEY ("variantId", "tenantId") REFERENCES "product_variants"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_reservations" ADD CONSTRAINT "fk_stock_reservations_location" FOREIGN KEY ("locationId", "tenantId") REFERENCES "inventory_locations"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Without reservations nothing is held any more
    await queryRunner.query(
      `UPDATE "stock_levels" SET "quantityReserved" = 0, "quantityAvailable" = "quantityOnHand" WHERE "quantityReserved" <> 0`,
    );
    await queryRunner.query(`DROP TABLE "stock_reservations"`);
    await queryRunner.query(
      `DROP TYPE "public"."stock_reservations_status_enum"`,
    );
  }
}
