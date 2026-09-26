import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntityWithVersion } from './base.entity';
import { Tenant } from './tenant.entity';
import { Branch } from './branch.entity';
import { InventoryLocation } from './inventory-location.entity';

export enum RegisterStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * How the register's drawers are run:
 * - assigned: one cashier per drawer shift (a second cashier opens another drawer)
 * - shared: cashiers share the drawer's one shift; each sale keeps its cashier and
 *   the drawer is counted once at close
 */
export enum DrawerPolicy {
  ASSIGNED = 'assigned',
  SHARED = 'shared',
}

@Entity('registers')
@Unique('uq_register_code', ['tenantId', 'code'])
@Index(['branchId'])
// version: optimistic concurrency for admin edits (If-Match)
export class Register extends BaseEntityWithVersion {
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

  // Drawers are rows of `drawers` (one is created with every register)
  @Column({
    type: 'varchar',
    length: 20,
    default: DrawerPolicy.ASSIGNED,
    nullable: false,
  })
  drawerPolicy: DrawerPolicy;

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
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => Branch, (branch) => branch.registers, {
    onDelete: 'CASCADE',
  })
  @JoinColumn([
    { name: 'tenantId', referencedColumnName: 'tenantId' },
    { name: 'branchId', referencedColumnName: 'id' },
  ])
  branch: Branch;

  @ManyToOne(() => InventoryLocation, { nullable: true })
  @JoinColumn([
    { name: 'tenantId', referencedColumnName: 'tenantId' },
    { name: 'defaultLocationId', referencedColumnName: 'id' },
  ])
  defaultLocation: InventoryLocation;
}
