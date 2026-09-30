import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Paid-in, paid-out and safe drops can be in another currency the store accepts
 * (e.g. HTG): cash_movements."currencyCode". NULL = the shift's own currency, so
 * every existing row (and every automatic movement: expenses, refunds...) keeps
 * its meaning.
 */
export class CashMovementCurrency1790780000000 implements MigrationInterface {
  name = 'CashMovementCurrency1790780000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cash_movements" ADD COLUMN IF NOT EXISTS "currencyCode" character varying(3)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cash_movements" DROP COLUMN IF EXISTS "currencyCode"`,
    );
  }
}
