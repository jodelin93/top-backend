import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { GoodsReceipt } from './goods-receipt.entity';
import { PurchaseOrderItem } from './purchase-order-item.entity';
import { ProductVariant } from './product-variant.entity';

export enum ReceiptCondition {
  GOOD = 'good',
  DAMAGED = 'damaged',
}

@Entity('goods_receipt_items')
@Unique('uq_goods_receipt_items_id_tenant', ['id', 'tenantId'])
@Index('idx_goods_receipt_items_receipt', ['receiptId'])
@Index('idx_goods_receipt_items_po_item', ['purchaseOrderItemId'])
export class GoodsReceiptItem extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  receiptId: string;

  // Null on an unplanned receipt
  @Column({ type: 'uuid', nullable: true })
  purchaseOrderItemId: string | null;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  quantity: number;

  // Cost posted to stock for these units (defaults to the PO line's unit cost)
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  unitCost: number;

  @Column({
    type: 'enum',
    enum: ReceiptCondition,
    enumName: 'goods_receipt_items_condition_enum',
    default: ReceiptCondition.GOOD,
    nullable: false,
  })
  condition: ReceiptCondition;

  // Damaged units are only put into stock when accepted; rejected ones are
  // recorded without stock (and stay outstanding on the order)
  @Column({ type: 'boolean', default: true, nullable: false })
  accepted: boolean;

  // Units of this line sent back to the supplier (supplier returns)
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityReturned: number;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_goods_receipt_items_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => GoodsReceipt, (receipt) => receipt.items, {
    onDelete: 'CASCADE',
  })
  @JoinColumn([
    {
      name: 'receiptId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_goods_receipt_items_receipt',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  receipt: GoodsReceipt;

  @ManyToOne(() => PurchaseOrderItem, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'purchaseOrderItemId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_goods_receipt_items_po_item',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  purchaseOrderItem: PurchaseOrderItem | null;

  @ManyToOne(() => ProductVariant, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'variantId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_goods_receipt_items_variant',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  variant: ProductVariant;
}
