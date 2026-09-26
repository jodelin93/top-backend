import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSaleIdempotencyIndex1790270755764 implements MigrationInterface {
  name = 'AddSaleIdempotencyIndex1790270755764';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_sale_idempotency" ON "sales"  ("tenantId", "idempotencyKey") WHERE "idempotencyKey" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."uq_sale_idempotency"`);
  }
}
