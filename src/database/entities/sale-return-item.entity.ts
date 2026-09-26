import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { SaleReturn } from './sale-return.entity';
import { SaleItem } from './sale-item.entity';

export enum ReturnDisposition {
  // Back on the shelf: stock goes up at the chosen location
  RESTOCK = 'restock',
  // Damaged / unsellable: refunded, stock unchanged
  DISPOSE = 'dispose',
  // Damaged but kept: back in stock at the warehouse's damaged / quarantine
  // location (InventoryService.resolveConditionLocation), never sellable
  DAMAGED = 'damaged',
}

@Entity('sale_return_items')
@Index('IDX_return_items_return', ['returnId'])
@Index('IDX_return_items_sale_item', ['saleItemId'])
export class SaleReturnItem extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  returnId: string;

  @Column({ type: 'uuid', nullable: false })
  saleItemId: string;

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

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  unitPrice: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  subtotal: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  discountAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  taxAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  total: number;

  @Column({ type: 'enum', enum: ReturnDisposition, nullable: false })
  disposition: ReturnDisposition;

  // Stock location for restocked (and damaged, kept) items
  @Column({ type: 'uuid', nullable: true })
  locationId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reason: string | null;

  @ManyToOne(() => SaleReturn, (r) => r.items, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'returnId',
    foreignKeyConstraintName: 'FK_return_items_return',
  })
  saleReturn: SaleReturn;

  @ManyToOne(() => SaleItem, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'saleItemId',
    foreignKeyConstraintName: 'FK_return_items_sale_item',
  })
  saleItem: SaleItem;
}
