import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Paying in another currency: payments keep their amount in the sale currency and
 * record what was tendered and at what rate; shifts count foreign cash separately.
 */
export class AddMultiCurrencyPayments1790340000000 implements MigrationInterface {
  name = 'AddMultiCurrencyPayments1790340000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payments" ADD "tenderedCurrency" character(3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD "tenderedAmount" numeric(19,4)`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" ADD "exchangeRate" numeric(19,8)`,
    );
    await queryRunner.query(`ALTER TABLE "shifts" ADD "foreignCash" jsonb`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "shifts" DROP COLUMN "foreignCash"`);
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN "exchangeRate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN "tenderedAmount"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payments" DROP COLUMN "tenderedCurrency"`,
    );
  }
}
