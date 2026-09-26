import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Integration follow-ups:
 *
 * - shifts."openingForeignCash": foreign cash in the drawer at opening. A
 *   handover carries the counted foreign cash over; it is part of the
 *   expected foreign cash at close.
 * - exchange_links status 'cancelled': an incomplete exchange given up, its
 *   credit refunded instead of a replacement sale.
 * - Index on sync_change_log.changed_at for the daily prune of old rows.
 *
 * Settings (giftCardExpiryMonths) live in the tenants' settings JSON and
 * stored_value_accounts."expiresAt" already exists: nothing to add for them.
 */
export class IntegrationFollowUps1790600000000 implements MigrationInterface {
  name = 'IntegrationFollowUps1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "shifts" ADD COLUMN IF NOT EXISTS "openingForeignCash" jsonb`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."exchange_links_status_enum" ADD VALUE IF NOT EXISTS 'cancelled'`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_sync_change_log_changed_at" ON "sync_change_log" ("changed_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_sync_change_log_changed_at"`,
    );
    // Postgres can't drop an enum value: rebuild the type without it
    await queryRunner.query(
      `UPDATE "exchange_links" SET status = 'incomplete' WHERE status = 'cancelled'`,
    );
    await queryRunner.query(
      `ALTER TYPE "public"."exchange_links_status_enum" RENAME TO "exchange_links_status_enum_old"`,
    );
    await queryRunner.query(
      `CREATE TYPE "public"."exchange_links_status_enum" AS ENUM ('pending', 'completed', 'incomplete')`,
    );
    await queryRunner.query(
      `ALTER TABLE "exchange_links" ALTER COLUMN "status" DROP DEFAULT`,
    );
    await queryRunner.query(
      `ALTER TABLE "exchange_links" ALTER COLUMN "status" TYPE "public"."exchange_links_status_enum" USING "status"::text::"public"."exchange_links_status_enum"`,
    );
    await queryRunner.query(
      `ALTER TABLE "exchange_links" ALTER COLUMN "status" SET DEFAULT 'pending'`,
    );
    await queryRunner.query(
      `DROP TYPE "public"."exchange_links_status_enum_old"`,
    );
    await queryRunner.query(
      `ALTER TABLE "shifts" DROP COLUMN IF EXISTS "openingForeignCash"`,
    );
  }
}
