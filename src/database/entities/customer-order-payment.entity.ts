import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { CustomerOrder } from './customer-order.entity';
import { PaymentMethod } from './payment-method.entity';

export enum CustomerOrderPaymentType {
  // Money received for the order (cash goes into the session as a paid-in)
  DEPOSIT = 'deposit',
  // Deposit given back when the order is cancelled (cash out of the session)
  REFUND = 'refund',
}

/**
 * Append-only ledger of an order's deposits and refunds (a database trigger
 * rejects updates and deletes). Amounts are positive; the type gives the sign.
 * customer_orders.paidAmount is the projection: deposits − refunds.
 */
@Entity('customer_order_payments')
@Check('CHK_customer_order_payments_amount', '"amount" > 0')
@Index('IDX_customer_order_payments_order', ['tenantId', 'orderId'])
@Index('IDX_customer_order_payments_date', ['tenantId', 'createdAt'])
@Index(
  'uq_customer_order_payment_idempotency',
  ['tenantId', 'idempotencyKey'],
  {
    unique: true,
    where: '"idempotencyKey" IS NOT NULL',
  },
)
export class CustomerOrderPayment {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_customer_order_payments',
  })
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  orderId: string;

  @Column({
    type: 'enum',
    enum: CustomerOrderPaymentType,
    enumName: 'customer_order_payments_type_enum',
    nullable: false,
  })
  type: CustomerOrderPaymentType;

  // In the order currency
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  amount: number;

  @Column({ type: 'uuid', nullable: false })
  paymentMethodId: string;

  // Cheque / transfer / mobile money reference
  @Column({ type: 'varchar', length: 255, nullable: true })
  reference: string | null;

  // Paid in another currency: what was handed over and the rate used
  @Column({ type: 'char', length: 3, nullable: true })
  tenderedCurrency: string | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  tenderedAmount: number | null;

  @Column({ type: 'numeric', precision: 19, scale: 8, nullable: true })
  exchangeRate: number | null;

  // Cash: the session (shift) whose drawer it went into / came out of
  @Column({ type: 'uuid', nullable: true })
  shiftId: string | null;

  @Column({ type: 'uuid', nullable: true })
  registerId: string | null;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @Column({ type: 'uuid', nullable: true })
  approverId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  idempotencyKey: string | null;

  @ManyToOne(() => CustomerOrder, (order) => order.payments, {
    onDelete: 'RESTRICT',
  })
  @JoinColumn({
    name: 'orderId',
    foreignKeyConstraintName: 'FK_customer_order_payments_order',
  })
  order?: CustomerOrder;

  @ManyToOne(() => PaymentMethod, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'paymentMethodId',
    foreignKeyConstraintName: 'FK_customer_order_payments_method',
  })
  paymentMethod?: PaymentMethod;
}
