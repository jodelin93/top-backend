import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A supplier payment made in another currency than the supplier's (e.g. HTG paid
 * against a USD balance): the payment keeps the currency, the amount paid in it and
 * the rate used; `amount` stays in the supplier's currency (what it settles).
 */
export class SupplierPaymentCurrency1790810000000 implements MigrationInterface {
  name = 'SupplierPaymentCurrency1790810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "supplier_payments" ADD COLUMN IF NOT EXISTS "tenderedCurrency" character varying(3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "supplier_payments" ADD COLUMN IF NOT EXISTS "tenderedAmount" numeric(19,4)`,
    );
    await queryRunner.query(
      `ALTER TABLE "supplier_payments" ADD COLUMN IF NOT EXISTS "exchangeRate" numeric(19,8)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const column of [
      'exchangeRate',
      'tenderedAmount',
      'tenderedCurrency',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "supplier_payments" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }
}
