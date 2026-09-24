import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Warehouse } from './warehouse.entity';

export enum LocationType {
  BIN = 'bin',
  AISLE = 'aisle',
  ZONE = 'zone',
}

@Entity('inventory_locations')
@Unique('uq_location_code', ['warehouseId', 'code'])
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

  @Column({ type: 'boolean', default: true, nullable: false })
  isSellable: boolean;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @ManyToOne(() => Warehouse, (warehouse) => warehouse.locations, {
    onDelete: 'CASCADE',
  })
  @JoinColumn([
    { name: 'tenant_id', referencedColumnName: 'tenantId' },
    { name: 'warehouse_id', referencedColumnName: 'id' },
  ])
  warehouse: Warehouse;
}
