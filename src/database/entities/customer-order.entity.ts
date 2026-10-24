import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  Unique,
} from 'typeorm';
import { BaseEntityWithVersion } from './base.entity';
import { Customer } from './customer.entity';
import { CustomerOrderItem } from './customer-order-item.entity';
import { CustomerOrderPayment } from './customer-order-payment.entity';

/**
 * Order lifecycle (src/orders/order-rules.ts):
 *   open ──> ready ──> picked_up
 *     └───────┴──────> cancelled
 * A void of the pickup sale puts a picked-up order back to ready.
 */
export enum CustomerOrderStatus {
  // Taken, being prepared
  OPEN = 'open',
  // Ready for the customer to pick up
  READY = 'ready',
  // Picked up: sold by its pickup sale (saleId)
  PICKED_UP = 'picked_up',
  CANCELLED = 'cancelled',
}

// What happened to the deposits of a cancelled order
export type DepositOutcome = 'refunded' | 'kept' | 'none';

/**
 * An order for services (items not tracked in stock) prepared for a customer
 * who pays a deposit now and the rest at pickup. The order is not a sale: its
 * deposits are money held for the customer (customer_order_payments, cash in
 * the drawer of the session that took it). At pickup it is sold like an
 * estimate, at its prices, and the deposits pay part of that sale (the
 * ORDER_DEPOSIT tender): the revenue is the pickup sale's.
 */
@Entity('customer_orders')
@Check('CHK_customer_orders_paid', '"paidAmount" >= 0')
@Unique('uq_customer_order_number', ['tenantId', 'orderNumber'])
@Index('IDX_customer_orders_tenant_status', ['tenantId', 'status', 'createdAt'])
@Index('IDX_customer_orders_customer', ['tenantId', 'customerId'])
@Index('IDX_customer_orders_sale', ['tenantId', 'saleId'], {
  where: '"saleId" IS NOT NULL',
})
@Index('uq_customer_order_idempotency', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
export class CustomerOrder extends BaseEntityWithVersion {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  orderNumber: string;

  @Column({ type: 'uuid', nullable: false })
  branchId: string;

  // Register the order was taken at
  @Column({ type: 'uuid', nullable: false })
  registerId: string;

  @Column({ type: 'uuid', nullable: false })
  customerId: string;

  // Who took the order
  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @Column({
    type: 'enum',
    enum: CustomerOrderStatus,
    enumName: 'customer_orders_status_enum',
    default: CustomerOrderStatus.OPEN,
    nullable: false,
  })
  status: CustomerOrderStatus;

  // When the customer is told to come back
  @Column({ type: 'date', nullable: true })
  readyBy: string | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  subtotal: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  discountAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  taxAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  total: number;

  // Deposits received minus deposits refunded (projection of the payments)
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  paidAmount: number;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  // Manual discount on the whole order, honoured at pickup
  @Column({ type: 'jsonb', nullable: true })
  cartDiscount: { type: 'percentage' | 'fixed'; value: number } | null;

  // Customer group discount given when the order was taken (%), honoured at pickup
  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
    nullable: false,
  })
  groupDiscountPercent: number;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  readyAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  readyById: string | null;

  // The pickup sale
  @Column({ type: 'uuid', nullable: true })
  saleId: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  pickedUpAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  cancelledById: string | null;

  // Manager who approved the cancellation (when the user could not cancel alone)
  @Column({ type: 'uuid', nullable: true })
  cancelApproverId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  cancelReason: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  depositOutcome: DepositOutcome | null;

  // Retried requests never take the same order twice
  @Column({ type: 'varchar', length: 100, nullable: true })
  idempotencyKey: string | null;

  @ManyToOne(() => Customer, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'customerId',
    foreignKeyConstraintName: 'FK_customer_orders_customer',
  })
  customer?: Customer;

  @OneToMany(() => CustomerOrderItem, (item) => item.order)
  items: CustomerOrderItem[];

  @OneToMany(() => CustomerOrderPayment, (payment) => payment.order)
  payments: CustomerOrderPayment[];
}
