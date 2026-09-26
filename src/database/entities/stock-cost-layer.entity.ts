import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { ProductVariant } from './product-variant.entity';
import { InventoryLocation } from './inventory-location.entity';

/**
 * FIFO cost layer: a batch of units that came into a location at one unit cost.
 * Inbound movements add a layer; outbound movements consume the oldest layers first.
 * Maintained whatever the costing method, so a store can switch methods later.
 */
@Entity('stock_cost_layers')
@Index('idx_stock_cost_layers_tenant', ['tenantId'])
@Index(
  'idx_stock_cost_layers_open',
  ['tenantId', 'variantId', 'locationId', 'receivedAt'],
  { where: `"quantityRemaining" > 0` },
)
export class StockCostLayer extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'uuid', nullable: false })
  locationId: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  quantityReceived: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  quantityRemaining: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  unitCost: number;

  @Column({
    type: 'timestamptz',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  receivedAt: Date;

  // The movement's reference (e.g. goods_receipt + id)
  @Column({ type: 'varchar', length: 50, nullable: true })
  sourceType: string | null;

  @Column({ type: 'uuid', nullable: true })
  sourceId: string | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_stock_cost_layers_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => ProductVariant, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'variantId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_stock_cost_layers_variant',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  variant: ProductVariant;

  @ManyToOne(() => InventoryLocation, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'locationId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_stock_cost_layers_location',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  location: InventoryLocation;
}
