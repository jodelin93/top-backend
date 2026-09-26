import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Which credit (payment, credit note, reversal, negative adjustment) settled
 * which debit (charge, opening balance), and how much. Credits go to the oldest
 * open debits first (FIFO); a credit tied to a sale settles that sale's charge
 * first. A debit's open amount = its amount − its allocations (aging).
 */
@Entity('customer_credit_allocations')
@Index('IDX_credit_alloc_debit', ['debitEntryId'])
@Index('IDX_credit_alloc_credit', ['creditEntryId'])
@Index('IDX_credit_alloc_customer', ['tenantId', 'customerId'])
export class CustomerCreditAllocation {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_customer_credit_allocations',
  })
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  customerId: string;

  @Column({ type: 'uuid', nullable: false })
  debitEntryId: string;

  @Column({ type: 'uuid', nullable: false })
  creditEntryId: string;

  // Always positive
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  amount: number;
}
