import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { ProductVariant } from './product-variant.entity';
import { InventoryLocation } from './inventory-location.entity';

export enum ReservationStatus {
  ACTIVE = 'active',
  RELEASED = 'released',
  COMMITTED = 'committed',
  EXPIRED = 'expired',
}

/**
 * Stock held for something that has not happened yet (a held cart, an order).
 * While active, `quantity` counts towards stock_levels.quantityReserved at the
 * location, so it is not available to other sales.
 */
@Entity('stock_reservations')
@Index('idx_stock_reservations_tenant', ['tenantId'])
@Index('idx_stock_reservations_reference', [
  'tenantId',
  'referenceType',
  'referenceId',
])
@Index('idx_stock_reservations_level', ['variantId', 'locationId'])
@Index('idx_stock_reservations_active_expiry', ['expiresAt'], {
  where: `"status" = 'active'`,
})
export class StockReservation extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'uuid', nullable: false })
  locationId: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  quantity: number;

  // What holds the stock, e.g. 'held_cart' + the cart id
  @Column({ type: 'varchar', length: 50, nullable: false })
  referenceType: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  referenceId: string;

  // Null = never expires on its own
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({
    type: 'enum',
    enum: ReservationStatus,
    enumName: 'stock_reservations_status_enum',
    default: ReservationStatus.ACTIVE,
    nullable: false,
  })
  status: ReservationStatus;

  // When it stopped being active (released, committed or expired)
  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_stock_reservations_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => ProductVariant, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'variantId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_stock_reservations_variant',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  variant: ProductVariant;

  @ManyToOne(() => InventoryLocation, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'locationId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_stock_reservations_location',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  location: InventoryLocation;
}
