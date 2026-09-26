import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { PurchaseOrder } from './purchase-order.entity';
import { ProductVariant } from './product-variant.entity';

@Entity('purchase_order_items')
@Unique('uq_purchase_order_items_id_tenant', ['id', 'tenantId'])
@Index(['tenantId'])
@Index(['purchaseOrderId'])
@Index(['variantId'])
export class PurchaseOrderItem extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  purchaseOrderId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  sku: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  productName: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  quantityOrdered: number;

  // Units received into stock (good + accepted damaged); may exceed ordered
  // within the over-receipt tolerance
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityReceived: number;

  // Units no longer expected (short-close)
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityCancelled: number;

  // Price before the line discount
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  unitCost: number;

  // Line discount, 0–100
  @Column({
    type: 'numeric',
    precision: 7,
    scale: 4,
    default: 0,
    nullable: false,
  })
  discountPercent: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  discountAmount: number;

  // e.g. "each", "case of 12" (free text, as the supplier sells it)
  @Column({ type: 'varchar', length: 30, nullable: true })
  unitOfMeasure: string | null;

  // Supplier's code for the product
  @Column({ type: 'varchar', length: 100, nullable: true })
  supplierSku: string | null;

  // quantity × unit cost − discount (before tax)
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  subtotal: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  taxAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  total: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  notes: string;

  @Column({ type: 'int', default: 0, nullable: false })
  lineNumber: number;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => PurchaseOrder, (po) => po.items, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'purchaseOrderId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  purchaseOrder: PurchaseOrder;

  @ManyToOne(() => ProductVariant, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'variantId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  variant: ProductVariant;
}
