import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Warehouse } from './warehouse.entity';

export enum LocationType {
  BIN = 'bin',
  AISLE = 'aisle',
  ZONE = 'zone',
}

/**
 * What the stock at a location may be used for. Only sellable stock counts as
 * available to sell; quarantine / damaged hold returned or received goods that
 * need inspection; transit holds transfers between dispatch and receipt (one
 * system location per store).
 */
export enum LocationStockStatus {
  SELLABLE = 'sellable',
  QUARANTINE = 'quarantine',
  DAMAGED = 'damaged',
  TRANSIT = 'transit',
}

@Entity('inventory_locations')
@Unique('uq_location_code', ['warehouseId', 'code'])
@Unique('uq_location_id_tenant', ['id', 'tenantId'])
@Index(['warehouseId'])
export class InventoryLocation extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  warehouseId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  name: string;

  @Column({
    type: 'enum',
    enum: LocationType,
    default: LocationType.BIN,
    nullable: false,
  })
  locationType: LocationType;

  // Kept in line with stockStatus (true only for sellable locations)
  @Column({ type: 'boolean', default: true, nullable: false })
  isSellable: boolean;

  @Column({
    type: 'enum',
    enum: LocationStockStatus,
    enumName: 'inventory_locations_stockstatus_enum',
    default: LocationStockStatus.SELLABLE,
    nullable: false,
  })
  stockStatus: LocationStockStatus;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => Warehouse, (warehouse) => warehouse.locations, {
    onDelete: 'CASCADE',
  })
  @JoinColumn([
    { name: 'tenantId', referencedColumnName: 'tenantId' },
    { name: 'warehouseId', referencedColumnName: 'id' },
  ])
  warehouse: Warehouse;
}
