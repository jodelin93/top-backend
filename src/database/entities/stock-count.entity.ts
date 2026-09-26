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
import { User } from './user.entity';
import { StockCountItem } from './stock-count-item.entity';

export enum StockCountStatus {
  // Counting: counted quantities can be entered
  IN_PROGRESS = 'in_progress',
  // Submitted with a variance above the tolerance: waits for inventory.count.approve
  PENDING_APPROVAL = 'pending_approval',
  // RECOUNT adjustments posted
  POSTED = 'posted',
  CANCELLED = 'cancelled',
}

/**
 * Stock count session for one location (R065). Expected quantities are a
 * snapshot taken when the session starts.
 */
@Entity('stock_counts')
@Unique('uq_stock_counts_number', ['tenantId', 'countNumber'])
@Unique('uq_stock_counts_id_tenant', ['id', 'tenantId'])
@Index('idx_stock_counts_tenant_status', ['tenantId', 'status'])
@Index('idx_stock_counts_location', ['locationId'])
export class StockCount extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  // CNT-000001
  @Column({ type: 'varchar', length: 50, nullable: false })
  countNumber: string;

  @Column({ type: 'uuid', nullable: false })
  locationId: string;

  // Only products of this category (and its sub-categories) are counted
  @Column({ type: 'uuid', nullable: true })
  categoryId: string | null;

  // Blind count: expected quantities are hidden while counting
  @Column({ type: 'boolean', default: false, nullable: false })
  blind: boolean;

  @Column({
    type: 'enum',
    enum: StockCountStatus,
    enumName: 'stock_counts_status_enum',
    default: StockCountStatus.IN_PROGRESS,
    nullable: false,
  })
  status: StockCountStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  // When the expected quantities were snapshotted: movements posted after it
  // (and before a line was counted) roll the expected quantity forward
  @Column({
    type: 'timestamptz',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  snapshotAt: Date;

  @Column({ type: 'uuid', nullable: false })
  createdById: string;

  @Column({ type: 'uuid', nullable: true })
  submittedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  approvedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  postedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_stock_counts_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => InventoryLocation, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'locationId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_stock_counts_location',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  location: InventoryLocation;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'createdById',
    foreignKeyConstraintName: 'fk_stock_counts_created_by',
  })
  createdBy: User;

  @OneToMany(() => StockCountItem, (item) => item.count)
  items: StockCountItem[];
}
