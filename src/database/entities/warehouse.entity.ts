import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
  OneToMany,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { InventoryLocation } from './inventory-location.entity';

export enum WarehouseType {
  STANDARD = 'standard',
  TRANSIT = 'transit',
  QUARANTINE = 'quarantine',
}

export enum WarehouseStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

@Entity('warehouses')
@Unique('uq_warehouse_code', ['tenantId', 'code'])
@Index(['tenantId'])
export class Warehouse extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  name: string;

  @Column({
    type: 'enum',
    enum: WarehouseType,
    default: WarehouseType.STANDARD,
    nullable: false,
  })
  warehouseType: WarehouseType;

  @Column({ type: 'varchar', length: 255, nullable: true })
  addressLine1: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  addressLine2: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  stateProvince: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  postalCode: string;

  @Column({ type: 'char', length: 2, nullable: true })
  countryCode: string;

  @Column({
    type: 'enum',
    enum: WarehouseStatus,
    default: WarehouseStatus.ACTIVE,
    nullable: false,
  })
  status: WarehouseStatus;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @OneToMany(() => InventoryLocation, (location) => location.warehouse)
  locations: InventoryLocation[];
}
