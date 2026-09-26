import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Branch } from './branch.entity';
import { Warehouse } from './warehouse.entity';

/**
 * Warehouses a branch works from (spec §3/§9). Branch-limited users see and move
 * the stock of these warehouses' locations only. A warehouse may serve several
 * branches; one assigned to no branch is visible to all-branch users only.
 */
@Entity('branch_warehouses')
@Index('UQ_branch_warehouses', ['branchId', 'warehouseId'], { unique: true })
@Index('IDX_branch_warehouses_tenant_warehouse', ['tenantId', 'warehouseId'])
export class BranchWarehouse extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  branchId: string;

  @Column({ type: 'uuid', nullable: false })
  warehouseId: string;

  @ManyToOne(() => Branch, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'branchId',
    foreignKeyConstraintName: 'FK_branch_warehouses_branch',
  })
  branch?: Branch;

  @ManyToOne(() => Warehouse, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'warehouseId',
    foreignKeyConstraintName: 'FK_branch_warehouses_warehouse',
  })
  warehouse?: Warehouse;
}
