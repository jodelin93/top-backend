import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { SupplierReturn } from './supplier-return.entity';
import { GoodsReceiptItem } from './goods-receipt-item.entity';
import { ProductVariant } from './product-variant.entity';

@Entity('supplier_return_items')
@Index('idx_supplier_return_items_return', ['returnId'])
@Index('idx_supplier_return_items_receipt_item', ['receiptItemId'])
export class SupplierReturnItem extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  returnId: string;

  @Column({ type: 'uuid', nullable: false })
  receiptItemId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  quantity: number;

  // Receipt unit cost: the value credited by the supplier
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  unitCost: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  total: number;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_supplier_return_items_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => SupplierReturn, (r) => r.items, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'returnId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_return_items_return',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  supplierReturn: SupplierReturn;

  @ManyToOne(() => GoodsReceiptItem, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'receiptItemId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_return_items_receipt_item',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  receiptItem: GoodsReceiptItem;

  @ManyToOne(() => ProductVariant, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'variantId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_return_items_variant',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  variant: ProductVariant;
}
