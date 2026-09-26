import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Tenant } from './tenant.entity';
import { Customer } from './customer.entity';

export type ConsentChannel = 'email' | 'sms';

/**
 * Append-only history of a customer's marketing consent (a database trigger
 * rejects edits; only a merge may re-point rows to the surviving customer).
 */
@Entity('customer_consent_events')
@Index('IDX_customer_consent_events_customer', [
  'tenantId',
  'customerId',
  'createdAt',
])
export class CustomerConsentEvent {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_customer_consent_events',
  })
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  customerId: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  channel: ConsentChannel;

  @Column({ type: 'boolean', nullable: false })
  granted: boolean;

  // Where consent was captured: pos, admin, import, merge, ...
  @Column({ type: 'varchar', length: 50, nullable: true })
  source: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  note: string | null;

  @Column({ type: 'uuid', nullable: true })
  recordedById: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_customer_consent_events_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'customerId',
    foreignKeyConstraintName: 'FK_customer_consent_events_customer',
  })
  customer: Customer;
}
