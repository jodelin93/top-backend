import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * New products no longer allow negative stock unless asked for:
 * products.allowBackorder defaults to false.
 *
 * Existing rows are deliberately left as they are (the decision on negative
 * stock for the current catalog is pending); only the column default changes.
 */
export class StockSafetyDefaults1790360000000 implements MigrationInterface {
  name = 'StockSafetyDefaults1790360000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "products" ALTER COLUMN "allowBackorder" SET DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "products" ALTER COLUMN "allowBackorder" SET DEFAULT true`,
    );
  }
}
