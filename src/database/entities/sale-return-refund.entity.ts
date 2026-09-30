import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { SaleReturn } from './sale-return.entity';
import { PaymentMethod } from './payment-method.entity';

export enum RefundStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * Money given back for a return, per tender. Card refunds go through the original
 * payment's provider; cash comes out of the register's open shift.
 */
@Entity('sale_return_refunds')
@Index('IDX_return_refunds_return', ['returnId'])
@Index('IDX_return_refunds_payment', ['originalPaymentId'])
export class SaleReturnRefund extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  returnId: string;

  @Column({ type: 'uuid', nullable: false })
  paymentMethodId: string;

  // The original sale payment refunded back to (null: refunded another way)
  @Column({ type: 'uuid', nullable: true })
  originalPaymentId: string | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  amount: number;

  // Cash paid in another currency (e.g. HTG) goes back in it, at the original
  // payment's rate: that currency, the amount handed back and the rate (null = the
  // sale currency)
  @Column({ type: 'varchar', length: 3, nullable: true })
  tenderedCurrency: string | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  tenderedAmount: number | null;

  @Column({ type: 'numeric', precision: 19, scale: 8, nullable: true })
  exchangeRate: number | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  provider: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  providerReference: string | null;

  // Sent to the provider so a retried refund is never paid twice
  @Column({ type: 'varchar', length: 150, nullable: false })
  idempotencyKey: string;

  @Column({
    type: 'enum',
    enum: RefundStatus,
    default: RefundStatus.PENDING,
    nullable: false,
  })
  status: RefundStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  failureReason: string | null;

  @ManyToOne(() => SaleReturn, (r) => r.refunds, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'returnId',
    foreignKeyConstraintName: 'FK_return_refunds_return',
  })
  saleReturn: SaleReturn;

  @ManyToOne(() => PaymentMethod, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'paymentMethodId',
    foreignKeyConstraintName: 'FK_return_refunds_method',
  })
  paymentMethod: PaymentMethod;
}
