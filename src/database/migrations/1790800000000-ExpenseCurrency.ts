import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Expenses paid in another currency the store accepts (e.g. HTG): the amount stays
 * in the store currency (valued at the sell rate) for reports; the currency, the
 * amount paid in it and the rate are kept, and cash comes out of that currency's cash.
 */
export class ExpenseCurrency1790800000000 implements MigrationInterface {
  name = 'ExpenseCurrency1790800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "tenderedCurrency" character varying(3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "tenderedAmount" numeric(19,4)`,
    );
    await queryRunner.query(
      `ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "exchangeRate" numeric(19,8)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of [
      'exchangeRate',
      'tenderedAmount',
      'tenderedCurrency',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "expenses" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }
}
