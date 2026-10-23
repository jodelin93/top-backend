import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A user added by the store chooses their own password through a link e-mailed
 * to them, which also confirms their e-mail address:
 * - users.passwordSetupPending: created without a usable password, link not used yet
 * - users.emailVerifiedAt: set when a link from their mailbox was opened
 * - password_reset_tokens.purpose: 'reset' (forgot password) or 'setup' (new account)
 */
export class AccountSetupLinks1790840000000 implements MigrationInterface {
  name = 'AccountSetupLinks1790840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "passwordSetupPending" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "password_reset_tokens" ADD COLUMN IF NOT EXISTS "purpose" character varying(10) NOT NULL DEFAULT 'reset'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "password_reset_tokens" DROP COLUMN IF EXISTS "purpose"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "emailVerifiedAt"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "passwordSetupPending"`,
    );
  }
}
