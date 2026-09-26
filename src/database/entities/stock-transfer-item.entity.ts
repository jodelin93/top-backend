import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { StockTransfer } from './stock-transfer.entity';
import { ProductVariant } from './product-variant.entity';

@Entity('stock_transfer_items')
@Unique('uq_stock_transfer_items_variant', ['transferId', 'variantId'])
@Index('idx_stock_transfer_items_tenant', ['tenantId'])
export class StockTransferItem extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  transferId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  quantityRequested: number;

  // Left the source location
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityDispatched: number;

  // Arrived at the destination
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityReceived: number;

  // Dispatched but never arrived (lost / damaged in transit)
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityWrittenOff: number;

  // Arrived damaged (sent to the destination's quarantine location, or written off)
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityDamaged: number;

  // Reported missing at receipt; still in transit until found or written off
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityMissing: number;

  // Sent back to the source when the transfer was cancelled after dispatch
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityReturned: number;

  // Received above what was dispatched (counted in quantityDispatched too)
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityOverReceived: number;

  // Costed unit cost of the dispatched units; received units come in at this cost
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  unitCost: number | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_stock_transfer_items_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => StockTransfer, (transfer) => transfer.items, {
    onDelete: 'CASCADE',
  })
  @JoinColumn([
    {
      name: 'transferId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_stock_transfer_items_transfer',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  transfer: StockTransfer;

  @ManyToOne(() => ProductVariant, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'variantId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_stock_transfer_items_variant',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  variant: ProductVariant;
}
