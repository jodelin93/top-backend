import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FIFO cost layers (R066). Inbound stock movements add a layer per location,
 * outbound movements consume the oldest layers first.
 */
export class AddStockCostLayers1790302050000 implements MigrationInterface {
  name = 'AddStockCostLayers1790302050000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "stock_cost_layers" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "variantId" uuid NOT NULL,
        "locationId" uuid NOT NULL,
        "quantityReceived" integer NOT NULL,
        "quantityRemaining" integer NOT NULL,
        "unitCost" numeric(19,4) NOT NULL,
        "receivedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "sourceType" character varying(50),
        "sourceId" uuid,
        CONSTRAINT "PK_stock_cost_layers" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "idx_stock_cost_layers_tenant" ON "stock_cost_layers" ("tenantId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "idx_stock_cost_layers_open" ON "stock_cost_layers" ("tenantId", "variantId", "locationId", "receivedAt") WHERE "quantityRemaining" > 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_cost_layers" ADD CONSTRAINT "fk_stock_cost_layers_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_cost_layers" ADD CONSTRAINT "fk_stock_cost_layers_variant" FOREIGN KEY ("variantId", "tenantId") REFERENCES "product_variants"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "stock_cost_layers" ADD CONSTRAINT "fk_stock_cost_layers_location" FOREIGN KEY ("locationId", "tenantId") REFERENCES "inventory_locations"("id","tenantId") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "stock_cost_layers"`);
  }
}
