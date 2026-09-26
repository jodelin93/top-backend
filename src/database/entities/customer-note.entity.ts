import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Customer } from './customer.entity';

export enum CustomerNoteVisibility {
  // Everyone who can look up the customer
  ALL = 'all',
  // Only users with customers.manage
  MANAGERS = 'managers',
}

/** Internal notes on a customer (never printed, never shown to the customer) */
@Entity('customer_notes')
@Index('IDX_customer_notes_customer', ['tenantId', 'customerId', 'createdAt'])
export class CustomerNote extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  customerId: string;

  @Column({ type: 'text', nullable: false })
  body: string;

  @Column({
    type: 'enum',
    enum: CustomerNoteVisibility,
    enumName: 'customer_notes_visibility_enum',
    default: CustomerNoteVisibility.ALL,
    nullable: false,
  })
  visibility: CustomerNoteVisibility;

  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'customerId',
    foreignKeyConstraintName: 'FK_customer_notes_customer',
  })
  customer?: Customer;
}
