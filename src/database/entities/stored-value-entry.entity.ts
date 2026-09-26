import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { StoredValueAccount } from './stored-value-account.entity';

export enum StoredValueEntryType {
  // Gift card sold / activated with its value
  ISSUE = 'issue',
  // Spent as a payment
  REDEEM = 'redeem',
  // A refund paid onto the card / store credit
  REFUND_CREDIT = 'refund_credit',
  // An earlier movement undone (sale voided or cancelled)
  REVERSAL = 'reversal',
  // Manual correction (reason required)
  ADJUSTMENT = 'adjustment',
  // Remaining value written off at expiry
  EXPIRE = 'expire',
}

/**
 * Append-only movements of a gift card / store credit account. Signed amount:
 * + adds value, − takes it. A database trigger rejects updates and deletes.
 */
@Entity('stored_value_entries')
@Index('IDX_stored_value_entries_account', ['accountId', 'createdAt'])
@Index('IDX_stored_value_entries_sale', ['tenantId', 'saleId'], {
  where: '"saleId" IS NOT NULL',
})
export class StoredValueEntry {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_stored_value_entries',
  })
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  accountId: string;

  @Column({
    type: 'enum',
    enum: StoredValueEntryType,
    enumName: 'stored_value_entries_type_enum',
    nullable: false,
  })
  type: StoredValueEntryType;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  amount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  balanceAfter: number;

  @Column({ type: 'uuid', nullable: true })
  saleId: string | null;

  @Column({ type: 'uuid', nullable: true })
  paymentId: string | null;

  @Column({ type: 'uuid', nullable: true })
  returnId: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null;

  @ManyToOne(() => StoredValueAccount, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'accountId',
    foreignKeyConstraintName: 'FK_stored_value_entries_account',
  })
  account?: StoredValueAccount;
}
