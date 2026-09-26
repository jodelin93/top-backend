import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum LoyaltyTransactionType {
  // Points earned on a sale
  EARN = 'earn',
  // Points spent as a payment
  REDEEM = 'redeem',
  // Points taken back / given back when a sale is voided, cancelled or returned
  REVERSAL = 'reversal',
  // Manual correction by a manager
  ADJUSTMENT = 'adjustment',
}

/**
 * Append-only loyalty ledger. customers.loyaltyPoints is the running balance;
 * this table explains every change to it.
 */
@Entity('loyalty_transactions')
@Index('IDX_loyalty_customer_created', ['tenantId', 'customerId', 'createdAt'])
@Index('IDX_loyalty_sale', ['saleId'])
export class LoyaltyTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  customerId: string;

  @Column({ type: 'enum', enum: LoyaltyTransactionType, nullable: false })
  type: LoyaltyTransactionType;

  // Signed: positive adds points, negative removes them
  @Column({ type: 'int', nullable: false })
  points: number;

  @Column({ type: 'int', nullable: false })
  balanceAfter: number;

  // Money value involved (sale amount earned on, or amount paid with points)
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  amount: number | null;

  @Column({ type: 'uuid', nullable: true })
  saleId: string | null;

  @Column({ type: 'uuid', nullable: true })
  returnId: string | null;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  note: string | null;
}
