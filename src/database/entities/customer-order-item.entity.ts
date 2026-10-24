import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { CustomerOrder } from './customer-order.entity';

/** A line of an order, priced like the till when the order was taken */
@Entity('customer_order_items')
@Index('IDX_customer_order_items_order', ['orderId'])
export class CustomerOrderItem extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  orderId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  sku: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  productName: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  variantName: string | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  quantity: number;

  // Price the order was taken at (the catalog's, a price list's or a changed one)
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  unitPrice: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  catalogPrice: number;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
    nullable: false,
  })
  discountPercent: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  subtotal: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  discountAmount: number;

  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  taxRate: number | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  taxAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  total: number;

  // What to prepare (size, colours, text to print...)
  @Column({ type: 'varchar', length: 255, nullable: true })
  note: string | null;

  @Column({ type: 'int', default: 0, nullable: false })
  lineNumber: number;

  @ManyToOne(() => CustomerOrder, (order) => order.items, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'orderId',
    foreignKeyConstraintName: 'FK_customer_order_items_order',
  })
  order: CustomerOrder;
}
