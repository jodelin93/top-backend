import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sign-in hardening (security review):
 * - per-account lockout after repeated wrong passwords / two-factor codes, so
 *   guessing can't be spread over many IP addresses;
 * - the last two-factor time step used, so an observed code can't be replayed;
 * - 'invited' memberships: adding an account that already exists no longer
 *   attaches it silently — its owner must accept (no pre-created accounts
 *   taking over another store's invitation).
 */
export class AuthHardening1790730000000 implements MigrationInterface {
  name = 'AuthHardening1790730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE users
        ADD COLUMN "failedLoginCount" integer NOT NULL DEFAULT 0,
        ADD COLUMN "lockedUntil" timestamptz NULL,
        ADD COLUMN "mfaLastUsedStep" bigint NULL`);
    await queryRunner.query(
      `ALTER TYPE "public"."tenant_memberships_status_enum" ADD VALUE IF NOT EXISTS 'invited'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Enum values can't be dropped; pending invitations are simply removed
    await queryRunner.query(
      `DELETE FROM tenant_memberships WHERE status = 'invited'`,
    );
    await queryRunner.query(`
      ALTER TABLE users
        DROP COLUMN "mfaLastUsedStep",
        DROP COLUMN "lockedUntil",
        DROP COLUMN "failedLoginCount"`);
  }
}
