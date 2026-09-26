import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** A user has read a notification (read state is per user) */
@Entity('notification_reads')
@Index('IDX_notification_reads_user', ['tenantId', 'userId'])
export class NotificationRead {
  @PrimaryColumn({ type: 'uuid' })
  notificationId: string;

  @PrimaryColumn({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  readAt: Date;
}
