import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A cash refund of money paid in another currency (e.g. HTG) is given back in that
 * currency, at the rate of the original payment: sale_return_refunds keeps the
 * currency, the amount handed back in it and the rate. NULL = the sale currency.
 */
export class RefundCurrency1790790000000 implements MigrationInterface {
  name = 'RefundCurrency1790790000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sale_return_refunds" ADD COLUMN IF NOT EXISTS "tenderedCurrency" character varying(3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_return_refunds" ADD COLUMN IF NOT EXISTS "tenderedAmount" numeric(19,4)`,
    );
    await queryRunner.query(
      `ALTER TABLE "sale_return_refunds" ADD COLUMN IF NOT EXISTS "exchangeRate" numeric(19,8)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of [
      'exchangeRate',
      'tenderedAmount',
      'tenderedCurrency',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "sale_return_refunds" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }
}
