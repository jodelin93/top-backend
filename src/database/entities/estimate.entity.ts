import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  Unique,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Customer } from './customer.entity';
import { EstimateItem } from './estimate-item.entity';

export enum EstimateStatus {
  DRAFT = 'draft',
  // Given / sent to the customer
  SENT = 'sent',
  ACCEPTED = 'accepted',
  DECLINED = 'declined',
  // Turned into a sale at the till
  CONVERTED = 'converted',
}

/**
 * A price quote for a customer. It reserves no stock and posts nothing; once accepted
 * it is loaded into the till and sold at the quoted prices.
 */
@Entity('estimates')
@Unique('uq_estimate_number', ['tenantId', 'estimateNumber'])
@Index('IDX_estimates_tenant_created', ['tenantId', 'createdAt'])
@Index('IDX_estimates_customer', ['customerId'])
export class Estimate extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  estimateNumber: string;

  @Column({ type: 'uuid', nullable: true })
  customerId: string | null;

  // Who the estimate is for when there's no customer record (walk-in, phone enquiry)
  @Column({ type: 'varchar', length: 255, nullable: true })
  customerName: string | null;

  @Column({ type: 'uuid', nullable: true })
  branchId: string | null;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @Column({
    type: 'enum',
    enum: EstimateStatus,
    default: EstimateStatus.DRAFT,
    nullable: false,
  })
  status: EstimateStatus;

  @Column({ type: 'date', nullable: false })
  issueDate: string;

  // After this date the estimate can no longer be converted without re-dating it
  @Column({ type: 'date', nullable: false })
  validUntil: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  subtotal: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  discountAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  taxAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  total: number;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  // Manual discount on the whole estimate
  @Column({ type: 'jsonb', nullable: true })
  cartDiscount: { type: 'percentage' | 'fixed'; value: number } | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  // Terms printed on the estimate (payment, delivery, warranty…)
  @Column({ type: 'varchar', length: 2000, nullable: true })
  terms: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  convertedSaleId: string | null;

  @ManyToOne(() => Customer, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'customerId',
    foreignKeyConstraintName: 'FK_estimates_customer',
  })
  customer: Customer | null;

  @OneToMany(() => EstimateItem, (item) => item.estimate)
  items: EstimateItem[];
}
