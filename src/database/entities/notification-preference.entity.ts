import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * A user's notification preferences in one store. No row = defaults
 * (in-app on, email off, every type, no quiet hours).
 */
@Entity('notification_preferences')
export class NotificationPreference {
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_notification_preferences',
  })
  tenantId: string;

  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_notification_preferences',
  })
  userId: string;

  @Column({ type: 'boolean', nullable: false, default: true })
  inApp: boolean;

  @Column({ type: 'boolean', nullable: false, default: false })
  email: boolean;

  // Notification types the user turned off (both channels)
  @Column({ type: 'jsonb', nullable: false, default: [] })
  mutedTypes: string[];

  // "HH:MM" in `timezone`; no email between start and end
  @Column({ type: 'varchar', length: 5, nullable: true })
  quietHoursStart: string | null;

  @Column({ type: 'varchar', length: 5, nullable: true })
  quietHoursEnd: string | null;

  // IANA time zone of the quiet hours (the user's browser zone), e.g. America/Port-au-Prince
  @Column({ type: 'varchar', length: 64, nullable: true })
  timezone: string | null;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  updatedAt: Date;
}
