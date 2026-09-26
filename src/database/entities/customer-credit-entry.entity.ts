import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Customer } from './customer.entity';

export enum CustomerCreditEntryType {
  // A sale (or part of it) put on the customer's account
  CHARGE = 'charge',
  // Money received against the account
  PAYMENT = 'payment',
  // Goods returned from a sale on account: the charge is reduced
  CREDIT_NOTE = 'credit_note',
  // Manual correction by a manager (reason required)
  ADJUSTMENT = 'adjustment',
  // Balance carried over from before the system (first entry only)
  OPENING_BALANCE = 'opening_balance',
  // A charge cancelled with its sale (void / cancelled card sale)
  REVERSAL = 'reversal',
}

/** Entries that add to what the customer owes (positive amounts) */
export const DEBIT_ENTRY_TYPES: readonly CustomerCreditEntryType[] = [
  CustomerCreditEntryType.CHARGE,
  CustomerCreditEntryType.OPENING_BALANCE,
];

/**
 * Append-only customer account ledger (D019). The amount is signed: positive
 * adds to what the customer owes, negative reduces it. customers.currentBalance
 * is a projection of SUM(amount), updated in the same transaction as the entry;
 * a database trigger rejects updates and deletes (see the migration).
 */
@Entity('customer_credit_entries')
@Index('IDX_credit_entries_customer', ['tenantId', 'customerId', 'createdAt'])
@Index('IDX_credit_entries_sale', ['tenantId', 'saleId'], {
  where: '"saleId" IS NOT NULL',
})
@Index('uq_credit_entry_idempotency', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
export class CustomerCreditEntry {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_customer_credit_entries',
  })
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  customerId: string;

  @Column({
    type: 'enum',
    enum: CustomerCreditEntryType,
    enumName: 'customer_credit_entries_type_enum',
    nullable: false,
  })
  type: CustomerCreditEntryType;

  // Signed: + the customer owes more, − the customer owes less
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  amount: number;

  // Account balance right after this entry
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  balanceAfter: number;

  @Column({ type: 'uuid', nullable: true })
  saleId: string | null;

  @Column({ type: 'uuid', nullable: true })
  returnId: string | null;

  // Payments: how the customer paid, and the cheque / transfer / approval reference
  @Column({ type: 'uuid', nullable: true })
  paymentMethodId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  paymentRef: string | null;

  // Charges: when payment is due (sale date + payment terms)
  @Column({ type: 'date', nullable: true })
  dueDate: string | null;

  // Reversals: the entry they cancel
  @Column({ type: 'uuid', nullable: true })
  reversalOfId: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;

  @Column({ type: 'uuid', nullable: true })
  approverId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null;

  // Retried requests (till payments) never post twice
  @Column({ type: 'varchar', length: 100, nullable: true })
  idempotencyKey: string | null;

  @ManyToOne(() => Customer, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'customerId',
    foreignKeyConstraintName: 'FK_credit_entries_customer',
  })
  customer?: Customer;
}
