import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export type NotificationSeverity = 'info' | 'warning' | 'critical';

/**
 * In-app notification (spec §15). Addressed to one user (recipientUserId) or to
 * everyone holding a permission (recipientPermission), limited to members of its
 * branch / stock location when it has one. Each user reads it for themselves
 * (notification_reads); `readAt` here means closed (its condition cleared).
 * While open, a dedupeKey is unique per store: raising the same alert again
 * bumps `occurrences` (and shows it unread again) instead of adding a row.
 */
@Entity('notifications')
@Index('IDX_notifications_tenant_created', ['tenantId', 'createdAt'])
@Index('UQ_notifications_open_dedupe', ['tenantId', 'dedupeKey'], {
  unique: true,
  where: '"readAt" IS NULL AND "dedupeKey" IS NOT NULL',
})
export class Notification {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_notifications',
  })
  id: string;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: true })
  recipientUserId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  recipientPermission: string | null;

  // The branch / stock location the alert is about (null: store-wide)
  @Column({ type: 'uuid', nullable: true })
  branchId: string | null;

  @Column({ type: 'uuid', nullable: true })
  locationId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: false })
  type: string;

  @Column({ type: 'varchar', length: 20, nullable: false, default: 'info' })
  severity: NotificationSeverity;

  @Column({ type: 'varchar', length: 255, nullable: false })
  title: string;

  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  entityType: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  entityId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  dedupeKey: string | null;

  @Column({ type: 'int', nullable: false, default: 1 })
  occurrences: number;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  lastOccurredAt: Date;

  // Closed: the condition cleared (not a user's read state)
  @Column({ type: 'timestamptz', nullable: true })
  readAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  readById: string | null;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  createdAt: Date;
}
