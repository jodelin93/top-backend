import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Platform tables: revocable sessions, registered POS devices (offline lease and
 * queue reporting) and the versioned settings history.
 */
export class AddPlatformSessionsDevicesSettingsVersions1790320000001 implements MigrationInterface {
  name = 'AddPlatformSessionsDevicesSettingsVersions1790320000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "user_sessions" (
        "id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "userId" uuid NOT NULL,
        "tenantId" uuid,
        "lastSeenAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "ip" character varying(64),
        "userAgent" character varying(500),
        "deviceId" uuid,
        "authMethod" character varying(20) NOT NULL DEFAULT 'password',
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "revokedReason" character varying(50),
        CONSTRAINT "PK_user_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_user_sessions_user" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE,
        CONSTRAINT "FK_user_sessions_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_user_sessions_user" ON "user_sessions" ("userId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_user_sessions_tenant" ON "user_sessions" ("tenantId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "devices" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "name" character varying(100) NOT NULL,
        "type" character varying(20) NOT NULL DEFAULT 'pos',
        "registerId" uuid,
        "userAgent" character varying(500),
        "appVersion" character varying(50),
        "registeredAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "registeredBy" uuid,
        "lastSeenAt" TIMESTAMP WITH TIME ZONE,
        "lastSeenBy" uuid,
        "lastSyncAt" TIMESTAMP WITH TIME ZONE,
        "pendingSales" integer NOT NULL DEFAULT 0,
        "failedSales" integer NOT NULL DEFAULT 0,
        "lastSequence" integer NOT NULL DEFAULT 0,
        "leaseExpiresAt" TIMESTAMP WITH TIME ZONE,
        "revokedAt" TIMESTAMP WITH TIME ZONE,
        "revokedBy" uuid,
        "revokedReason" character varying(255),
        CONSTRAINT "PK_devices" PRIMARY KEY ("id"),
        CONSTRAINT "FK_devices_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_devices_tenant" ON "devices" ("tenantId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "settings_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "tenantId" uuid NOT NULL,
        "version" integer NOT NULL,
        "changes" jsonb NOT NULL DEFAULT '{}',
        "changedKeys" jsonb NOT NULL DEFAULT '[]',
        "snapshot" jsonb NOT NULL DEFAULT '{}',
        "actorId" uuid,
        "effectiveFrom" TIMESTAMP WITH TIME ZONE NOT NULL,
        "appliedAt" TIMESTAMP WITH TIME ZONE,
        "cancelledAt" TIMESTAMP WITH TIME ZONE,
        "cancelledBy" uuid,
        "note" character varying(255),
        CONSTRAINT "PK_settings_versions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_settings_versions_tenant_version" UNIQUE ("tenantId", "version"),
        CONSTRAINT "FK_settings_versions_tenant" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_settings_versions_tenant_effective" ON "settings_versions" ("tenantId", "effectiveFrom")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_settings_versions_tenant_effective"`,
    );
    await queryRunner.query(`DROP TABLE "settings_versions"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_devices_tenant"`);
    await queryRunner.query(`DROP TABLE "devices"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_user_sessions_tenant"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_user_sessions_user"`);
    await queryRunner.query(`DROP TABLE "user_sessions"`);
  }
}
