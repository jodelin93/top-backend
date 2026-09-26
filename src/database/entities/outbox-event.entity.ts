import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Transactional outbox (spec §17): a domain event written in the same
 * transaction as the change it describes, then delivered by the outbox
 * publisher (OutboxPublisherService). Postgres is the durable truth; a row is
 * delivered once `publishedAt` is set, or parked once `deadLetteredAt` is set.
 */
@Entity('outbox_events')
@Index('IDX_outbox_events_pending', ['nextAttemptAt'], {
  where: '"publishedAt" IS NULL AND "deadLetteredAt" IS NULL',
})
@Index('IDX_outbox_events_tenant_occurred', ['tenantId', 'occurredAt'])
@Index('IDX_outbox_events_aggregate', ['aggregateType', 'aggregateId'])
export class OutboxEvent {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_outbox_events',
  })
  id: string;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  eventType: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  aggregateType: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  aggregateId: string;

  @Column({ type: 'int', nullable: true })
  aggregateVersion: number | null;

  @Column({ type: 'int', nullable: false, default: 1 })
  schemaVersion: number;

  @Column({ type: 'jsonb', nullable: false, default: {} })
  payload: Record<string, any>;

  // Request id of the command that produced the event
  @Column({ type: 'varchar', length: 100, nullable: true })
  correlationId: string | null;

  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  occurredAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'int', nullable: false, default: 0 })
  attempts: number;

  @Column({ type: 'text', nullable: true })
  lastError: string | null;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  nextAttemptAt: Date;

  // Claimed by a publisher until then (a crashed instance's claim expires)
  @Column({ type: 'timestamptz', nullable: true })
  lockedUntil: Date | null;

  // Gave up after the maximum attempts; retried only from the System events page
  @Column({ type: 'timestamptz', nullable: true })
  deadLetteredAt: Date | null;
}
