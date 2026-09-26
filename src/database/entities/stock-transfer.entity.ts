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
import { StockTransferItem } from './stock-transfer-item.entity';

export enum StockTransferStatus {
  DRAFT = 'draft',
  // Submitted, waiting for inventory.transfer.approve (above the store's threshold)
  REQUESTED = 'requested',
  // Approved (or needing no approval): can be dispatched
  APPROVED = 'approved',
  // Some requested units have left the source, more dispatches to come
  PARTIALLY_DISPATCHED = 'partially_dispatched',
  // Dispatched: stock has left the source location
  IN_TRANSIT = 'in_transit',
  PARTIALLY_RECEIVED = 'partially_received',
  // Everything dispatched was received or written off
  RECEIVED = 'received',
  // Before dispatch: dropped; after dispatch: what was in transit went back to the source
  CANCELLED = 'cancelled',
}

/**
 * Stock transfer between two locations (R067).
 * draft → requested → approved → (partially_)dispatched / in_transit →
 * partially_received → received, or cancelled. Units between dispatch and
 * receipt sit in the store's transit location as ledger movements
 * (source → transit → destination), so quantities are conserved in the ledger.
 */
@Entity('stock_transfers')
@Unique('uq_stock_transfers_number', ['tenantId', 'transferNumber'])
@Unique('uq_stock_transfers_id_tenant', ['id', 'tenantId'])
@Index('idx_stock_transfers_tenant_status', ['tenantId', 'status'])
export class StockTransfer extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  // TRF-000001
  @Column({ type: 'varchar', length: 50, nullable: false })
  transferNumber: string;

  @Column({ type: 'uuid', nullable: false })
  fromLocationId: string;

  @Column({ type: 'uuid', nullable: false })
  toLocationId: string;

  @Column({
    type: 'enum',
    enum: StockTransferStatus,
    enumName: 'stock_transfers_status_enum',
    default: StockTransferStatus.DRAFT,
    nullable: false,
  })
  status: StockTransferStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  @Column({ type: 'uuid', nullable: false })
  createdById: string;

  @Column({ type: 'timestamptz', nullable: true })
  dispatchedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  dispatchedById: string | null;

  // Fully received / closed
  @Column({ type: 'timestamptz', nullable: true })
  receivedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  // False for transfers dispatched before transit locations existed: their
  // in-transit units only live in stock_levels.quantityInTransit
  @Column({ type: 'boolean', default: true, nullable: false })
  transitLedger: boolean;

  // The transit location its units sit in between dispatch and receipt
  @Column({ type: 'uuid', nullable: true })
  transitLocationId: string | null;

  // Needs inventory.transfer.approve before dispatch (decided when requested)
  @Column({ type: 'boolean', default: false, nullable: false })
  approvalRequired: boolean;

  @Column({ type: 'uuid', nullable: true })
  requestedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  requestedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  approvedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  // No more dispatches: what was requested but not sent is dropped
  @Column({ type: 'boolean', default: false, nullable: false })
  dispatchComplete: boolean;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_stock_transfers_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => InventoryLocation, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'fromLocationId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_stock_transfers_from_location',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  fromLocation: InventoryLocation;

  @ManyToOne(() => InventoryLocation, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'toLocationId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_stock_transfers_to_location',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  toLocation: InventoryLocation;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'createdById',
    foreignKeyConstraintName: 'fk_stock_transfers_created_by',
  })
  createdBy: User;

  @OneToMany(() => StockTransferItem, (item) => item.transfer)
  items: StockTransferItem[];
}
