import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Tenant } from './tenant.entity';

/**
 * Every webhook received from a payment provider, keyed by the provider's event id.
 * The unique key makes redelivered events no-ops (providers retry until they get a 2xx).
 */
@Entity('payment_webhook_events')
@Unique('uq_payment_webhook_event', ['provider', 'eventId'])
export class PaymentWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  // Known once the event is matched to a payment
  @Column({ type: 'uuid', nullable: true })
  tenantId: string | null;

  @Column({ type: 'varchar', length: 50, nullable: false })
  provider: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  eventId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  eventType: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  providerReference: string | null;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  payload: Record<string, any>;

  @Column({ type: 'timestamptz', nullable: true })
  processedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  error: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_payment_webhook_events_tenant',
  })
  tenant: Tenant | null;
}
