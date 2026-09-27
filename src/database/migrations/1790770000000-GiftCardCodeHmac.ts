import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gift card codes were stored as an unkeyed sha256 of `tenantId:code`: with a
 * copy of the database, short pre-printed codes could be brute-forced offline
 * (security review). New cards store an HMAC keyed with GIFT_CARD_CODE_SECRET
 * in "codeHmac". Existing cards can't be re-hashed (their codes are unknown):
 * they keep "codeHash" until their first lookup, which writes "codeHmac" and
 * clears "codeHash" (see StoredValueService.findGiftCardByCode).
 */
export class GiftCardCodeHmac1790770000000 implements MigrationInterface {
  name = 'GiftCardCodeHmac1790770000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "stored_value_accounts" ADD COLUMN IF NOT EXISTS "codeHmac" character varying(64)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "uq_stored_value_code_hmac" ON "stored_value_accounts" ("tenantId", "codeHmac") WHERE "codeHmac" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "stored_value_accounts" DROP CONSTRAINT "CHK_stored_value_owner"`,
    );
    await queryRunner.query(`
      ALTER TABLE "stored_value_accounts" ADD CONSTRAINT "CHK_stored_value_owner" CHECK (
        ("accountType" = 'gift_card' AND ("codeHash" IS NOT NULL OR "codeHmac" IS NOT NULL))
        OR ("accountType" = 'store_credit' AND "customerId" IS NOT NULL))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Cards upgraded to the HMAC have no legacy hash any more: they can't be
    // found after a revert. Refuse rather than lose them silently.
    const rows = (await queryRunner.query(
      `SELECT count(*)::text AS count FROM "stored_value_accounts" WHERE "codeHmac" IS NOT NULL`,
    )) as { count: string }[];
    const count = rows[0]?.count ?? '0';
    if (Number(count) > 0) {
      throw new Error(
        `${count} gift card(s) are keyed by codeHmac only; reverting would make them unfindable`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "stored_value_accounts" DROP CONSTRAINT "CHK_stored_value_owner"`,
    );
    await queryRunner.query(`
      ALTER TABLE "stored_value_accounts" ADD CONSTRAINT "CHK_stored_value_owner" CHECK (
        ("accountType" = 'gift_card' AND "codeHash" IS NOT NULL)
        OR ("accountType" = 'store_credit' AND "customerId" IS NOT NULL))
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "uq_stored_value_code_hmac"`);
    await queryRunner.query(
      `ALTER TABLE "stored_value_accounts" DROP COLUMN IF EXISTS "codeHmac"`,
    );
  }
}
