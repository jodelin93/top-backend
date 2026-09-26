import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Platform backbone (spec §15, §17, §18, §24):
 * - outbox_events / inbox_events: transactional outbox and consumer de-duplication
 * - idempotency_records: stored outcomes of commands sent with an Idempotency-Key
 * - notifications / notification_preferences: notification centre
 * - system_check_runs: scheduled reconciliation results
 * - version columns (optimistic concurrency) on branches, registers, categories
 *   and customer_groups
 * - new permission platform.operate for the built-in owner and admin roles
 */
export class PlatformBackbone1790420000000 implements MigrationInterface {
  name = 'PlatformBackbone1790420000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "outbox_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "eventType" character varying(100) NOT NULL,
        "aggregateType" character varying(50) NOT NULL,
        "aggregateId" character varying(100) NOT NULL,
        "aggregateVersion" integer,
        "schemaVersion" integer NOT NULL DEFAULT 1,
        "payload" jsonb NOT NULL DEFAULT '{}',
        "correlationId" character varying(100),
        "actorId" uuid,
        "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "publishedAt" TIMESTAMP WITH TIME ZONE,
        "attempts" integer NOT NULL DEFAULT 0,
        "lastError" text,
        "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "lockedUntil" TIMESTAMP WITH TIME ZONE,
        "deadLetteredAt" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_outbox_events" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_events_pending" ON "outbox_events" ("nextAttemptAt") WHERE "publishedAt" IS NULL AND "deadLetteredAt" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_events_tenant_occurred" ON "outbox_events" ("tenantId", "occurredAt")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_outbox_events_aggregate" ON "outbox_events" ("aggregateType", "aggregateId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "inbox_events" (
        "consumer" character varying(100) NOT NULL,
        "eventId" uuid NOT NULL,
        "tenantId" uuid,
        "eventType" character varying(100) NOT NULL,
        "processedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_inbox_events" PRIMARY KEY ("consumer", "eventId")
      )`);

    await queryRunner.query(`
      CREATE TABLE "idempotency_records" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "key" character varying(255) NOT NULL,
        "commandType" character varying(100) NOT NULL,
        "requestHash" character(64) NOT NULL,
        "responseStatus" integer,
        "responseBody" jsonb,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_idempotency_records" PRIMARY KEY ("id"),
        CONSTRAINT "uq_idempotency_records_key" UNIQUE ("tenantId", "key")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_idempotency_records_expires" ON "idempotency_records" ("expiresAt")`,
    );

    await queryRunner.query(`
      CREATE TABLE "notifications" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "recipientUserId" uuid,
        "recipientPermission" character varying(100),
        "type" character varying(100) NOT NULL,
        "severity" character varying(20) NOT NULL DEFAULT 'info',
        "title" character varying(255) NOT NULL,
        "body" text,
        "entityType" character varying(50),
        "entityId" character varying(100),
        "dedupeKey" character varying(255),
        "occurrences" integer NOT NULL DEFAULT 1,
        "lastOccurredAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "readAt" TIMESTAMP WITH TIME ZONE,
        "readById" uuid,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notifications" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_tenant_created" ON "notifications" ("tenantId", "createdAt")`,
    );
    // One open (unread) notification per store and dedupe key
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_notifications_open_dedupe" ON "notifications" ("tenantId", "dedupeKey") WHERE "readAt" IS NULL AND "dedupeKey" IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "notification_preferences" (
        "tenantId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "inApp" boolean NOT NULL DEFAULT true,
        "email" boolean NOT NULL DEFAULT false,
        "mutedTypes" jsonb NOT NULL DEFAULT '[]',
        "quietHoursStart" character varying(5),
        "quietHoursEnd" character varying(5),
        "timezone" character varying(64),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_preferences" PRIMARY KEY ("tenantId", "userId")
      )`);

    await queryRunner.query(`
      CREATE TABLE "system_check_runs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "tenantId" uuid NOT NULL,
        "trigger" character varying(20) NOT NULL,
        "requestedById" uuid,
        "startedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "finishedAt" TIMESTAMP WITH TIME ZONE,
        "status" character varying(20) NOT NULL DEFAULT 'running',
        "results" jsonb NOT NULL DEFAULT '[]',
        "error" text,
        CONSTRAINT "PK_system_check_runs" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_system_check_runs_tenant_started" ON "system_check_runs" ("tenantId", "startedAt")`,
    );

    // Optimistic concurrency (If-Match) for admin edits
    for (const table of [
      'branches',
      'registers',
      'categories',
      'customer_groups',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1`,
      );
    }

    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" || jsonb_build_array('platform.operate'::text)
       WHERE "isSystem" = true AND "key" IN ('owner', 'admin') AND NOT "permissions" ? 'platform.operate'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "tenant_roles" SET "permissions" = "permissions" - 'platform.operate'::text WHERE "permissions" ? 'platform.operate'`,
    );
    for (const table of [
      'customer_groups',
      'categories',
      'registers',
      'branches',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "version"`,
      );
    }
    await queryRunner.query(`DROP TABLE "system_check_runs"`);
    await queryRunner.query(`DROP TABLE "notification_preferences"`);
    await queryRunner.query(`DROP TABLE "notifications"`);
    await queryRunner.query(`DROP TABLE "idempotency_records"`);
    await queryRunner.query(`DROP TABLE "inbox_events"`);
    await queryRunner.query(`DROP TABLE "outbox_events"`);
  }
}
