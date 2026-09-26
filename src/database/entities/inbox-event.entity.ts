import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Consumer de-duplication: one row per (consumer, event) written in the same
 * transaction as the consumer's effect, so redelivered events are no-ops.
 */
@Entity('inbox_events')
export class InboxEvent {
  @PrimaryColumn({
    type: 'varchar',
    length: 100,
    primaryKeyConstraintName: 'PK_inbox_events',
  })
  consumer: string;

  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'PK_inbox_events' })
  eventId: string;

  @Column({ type: 'uuid', nullable: true })
  tenantId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: false })
  eventType: string;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  processedAt: Date;
}
