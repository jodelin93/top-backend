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
import { Branch } from './branch.entity';
import { InventoryLocation } from './inventory-location.entity';

export enum RegisterStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

@Entity('registers')
@Unique('uq_register_code', ['tenantId', 'code'])
@Index(['branchId'])
export class Register extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  branchId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  name: string;

  @Column({ type: 'uuid', nullable: true })
  defaultLocationId: string;

  @Column({ type: 'uuid', nullable: true })
  drawerId: string;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  settings: Record<string, any>;

  @Column({
    type: 'enum',
    enum: RegisterStatus,
    default: RegisterStatus.ACTIVE,
    nullable: false,
  })
  status: RegisterStatus;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @ManyToOne(() => Branch, (branch) => branch.registers, {
    onDelete: 'CASCADE',
  })
  @JoinColumn([
    { name: 'tenant_id', referencedColumnName: 'tenantId' },
    { name: 'branch_id', referencedColumnName: 'id' },
  ])
  branch: Branch;

  @ManyToOne(() => InventoryLocation, { nullable: true })
  @JoinColumn([
    { name: 'tenant_id', referencedColumnName: 'tenantId' },
    { name: 'default_location_id', referencedColumnName: 'id' },
  ])
  defaultLocation: InventoryLocation;
}
