import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
  OneToMany,
} from 'typeorm';
import { BaseEntityWithVersion } from './base.entity';
import { Tenant } from './tenant.entity';
import { Supplier } from './supplier.entity';
import { Warehouse } from './warehouse.entity';
import { InventoryLocation } from './inventory-location.entity';
import { User } from './user.entity';
import { PurchaseOrderItem } from './purchase-order-item.entity';

export enum PurchaseOrderStatus {
  DRAFT = 'draft',
  // Total above the store's purchaseApprovalThreshold: waits for purchasing.approve
  PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved',
  // Sent to the supplier
  ISSUED = 'issued',
  PARTIALLY_RECEIVED = 'partially_received',
  RECEIVED = 'received',
  // Finished: fully received, or short-closed (the unreceived remainder cancelled)
  CLOSED = 'closed',
  CANCELLED = 'cancelled',
}

@Entity('purchase_orders')
@Unique('uq_po_number', ['tenantId', 'poNumber'])
@Unique('uq_po_id_tenant', ['id', 'tenantId'])
@Index(['tenantId'])
@Index(['supplierId'])
@Index(['warehouseId'])
@Index(['status'])
@Index(['orderDate'])
@Index('idx_purchase_orders_location', ['locationId'])
export class PurchaseOrder extends BaseEntityWithVersion {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  poNumber: string;

  @Column({ type: 'uuid', nullable: false })
  supplierId: string;

  // Warehouse of the destination location (kept for reporting)
  @Column({ type: 'uuid', nullable: false })
  warehouseId: string;

  // Where the goods are received
  @Column({ type: 'uuid', nullable: false })
  locationId: string;

  @Column({
    type: 'timestamptz',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  orderDate: Date;

  @Column({ type: 'timestamptz', nullable: true })
  expectedDeliveryDate: Date;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  subtotal: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  taxAmount: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  shippingCost: number;

  // Sum of the line discounts (subtotal is already net of them)
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  discountAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  total: number;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string;

  @Column({
    type: 'enum',
    enum: PurchaseOrderStatus,
    default: PurchaseOrderStatus.DRAFT,
    nullable: false,
  })
  status: PurchaseOrderStatus;

  // ---- Lifecycle (userId is the creator) ----
  @Column({ type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  approvedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  issuedAt: Date | null;

  // Everything ordered has been received
  @Column({ type: 'timestamptz', nullable: true })
  receivedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  cancelReason: string | null;

  // Supplier's own reference (order confirmation / quote number)
  @Column({ type: 'varchar', length: 100, nullable: true })
  supplierReference: string | null;

  // Closed (short-close cancels what was not received)
  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  closeReason: string | null;

  // Number of revisions made after approval (0 = original)
  @Column({ type: 'int', default: 0, nullable: false })
  revisionNumber: number;

  // Who made the latest revision (must not approve it)
  @Column({ type: 'uuid', nullable: true })
  revisedById: string | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'supplierId' })
  supplier: Supplier;

  @ManyToOne(() => Warehouse, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'warehouseId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  warehouse: Warehouse;

  @ManyToOne(() => InventoryLocation, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'locationId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_purchase_orders_location',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  location: InventoryLocation;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @OneToMany(() => PurchaseOrderItem, (item) => item.purchaseOrder)
  items: PurchaseOrderItem[];
}
