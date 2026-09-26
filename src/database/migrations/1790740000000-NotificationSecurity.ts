import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Notification access (security review):
 * - the branch / stock location an alert is about, so branch-limited members
 *   only see alerts of their branches (spec §3/§9);
 * - read state per user (notification_reads): reading an alert no longer marks
 *   it read for every other recipient. notifications."readAt" now only means
 *   "closed" (the condition cleared, see NotificationsService.resolve).
 */
export class NotificationSecurity1790740000000 implements MigrationInterface {
  name = 'NotificationSecurity1790740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE notifications
        ADD COLUMN "branchId" uuid NULL,
        ADD COLUMN "locationId" uuid NULL`);
    await queryRunner.query(`
      ALTER TABLE notifications
        ADD CONSTRAINT "FK_notifications_branch"
          FOREIGN KEY ("branchId") REFERENCES branches (id) ON DELETE CASCADE,
        ADD CONSTRAINT "FK_notifications_location"
          FOREIGN KEY ("locationId") REFERENCES inventory_locations (id) ON DELETE CASCADE`);
    await queryRunner.query(
      `CREATE INDEX "IDX_notifications_tenant_branch" ON notifications ("tenantId", "branchId")`,
    );

    await queryRunner.query(`
      CREATE TABLE notification_reads (
        "notificationId" uuid NOT NULL,
        "userId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "readAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_notification_reads" PRIMARY KEY ("notificationId", "userId"),
        CONSTRAINT "FK_notification_reads_notification"
          FOREIGN KEY ("notificationId") REFERENCES notifications (id) ON DELETE CASCADE,
        CONSTRAINT "FK_notification_reads_user"
          FOREIGN KEY ("userId") REFERENCES users (id) ON DELETE CASCADE,
        CONSTRAINT "FK_notification_reads_tenant"
          FOREIGN KEY ("tenantId") REFERENCES tenants (id) ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `CREATE INDEX "IDX_notification_reads_user" ON notification_reads ("tenantId", "userId")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE notification_reads`);
    await queryRunner.query(`DROP INDEX "IDX_notifications_tenant_branch"`);
    await queryRunner.query(`
      ALTER TABLE notifications
        DROP CONSTRAINT "FK_notifications_location",
        DROP CONSTRAINT "FK_notifications_branch",
        DROP COLUMN "locationId",
        DROP COLUMN "branchId"`);
  }
}
