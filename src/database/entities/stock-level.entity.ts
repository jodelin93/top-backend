import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntityWithVersion } from './base.entity';
import { Tenant } from './tenant.entity';
import { ProductVariant } from './product-variant.entity';
import { InventoryLocation } from './inventory-location.entity';

@Entity('stock_levels')
@Unique('uq_stock_variant_location', ['variantId', 'locationId'])
@Index(['tenantId'])
@Index(['variantId'])
@Index(['locationId'])
export class StockLevel extends BaseEntityWithVersion {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'uuid', nullable: false })
  locationId: string;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityOnHand: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityReserved: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityAvailable: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityInTransit: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastCountedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  lastReceivedAt: Date;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => ProductVariant, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'variantId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  variant: ProductVariant;

  @ManyToOne(() => InventoryLocation, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'locationId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  location: InventoryLocation;
}
