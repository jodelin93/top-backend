import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { InventoryLocation } from './inventory-location.entity';
import { User } from './user.entity';

export enum AdjustmentStatus {
  DRAFT = 'draft',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

export enum AdjustmentReason {
  RECOUNT = 'recount',
  DAMAGE = 'damage',
  THEFT = 'theft',
  EXPIRY = 'expiry',
  OTHER = 'other',
}

@Entity('stock_adjustments')
@Unique('uq_adjustment_number', ['tenantId', 'adjustmentNumber'])
@Index(['tenantId'])
@Index(['locationId'])
@Index(['status'])
export class StockAdjustment extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  adjustmentNumber: string;

  @Column({ type: 'uuid', nullable: false })
  locationId: string;

  @Column({
    type: 'enum',
    enum: AdjustmentReason,
    nullable: false,
  })
  reason: AdjustmentReason;

  @Column({
    type: 'timestamptz',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  adjustmentDate: Date;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string;

  @Column({
    type: 'enum',
    enum: AdjustmentStatus,
    default: AdjustmentStatus.DRAFT,
    nullable: false,
  })
  status: AdjustmentStatus;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => InventoryLocation, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'locationId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  location: InventoryLocation;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'userId' })
  user: User;
}
