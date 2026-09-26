import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { PurchaseOrder } from './purchase-order.entity';
import { User } from './user.entity';

// Header and lines of an order as they were before / after a revision
export interface PurchaseOrderSnapshot {
  supplierId: string;
  locationId: string;
  expectedDeliveryDate: string | null;
  supplierReference: string | null;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  shippingCost: number;
  total: number;
  notes: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  lines: PurchaseOrderSnapshotLine[];
}

export interface PurchaseOrderSnapshotLine {
  variantId: string;
  sku: string;
  productName: string;
  quantityOrdered: number;
  quantityReceived: number;
  unitCost: number;
  discountPercent: number;
  discountAmount: number;
  subtotal: number;
  taxAmount: number;
  total: number;
  unitOfMeasure: string | null;
  supplierSku: string | null;
  notes: string | null;
}

/**
 * A change made to an order after it was approved (R071): the order before and
 * after, and whether it went back for approval.
 */
@Entity('purchase_order_revisions')
@Unique('uq_purchase_order_revisions_number', [
  'purchaseOrderId',
  'revisionNumber',
])
@Index('idx_purchase_order_revisions_tenant', ['tenantId'])
export class PurchaseOrderRevision extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  purchaseOrderId: string;

  // 1, 2, ...
  @Column({ type: 'int', nullable: false })
  revisionNumber: number;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  @Column({ type: 'varchar', length: 30, nullable: false })
  statusBefore: string;

  @Column({ type: 'varchar', length: 30, nullable: false })
  statusAfter: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  totalBefore: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  totalAfter: number;

  // The new total is above the approval threshold: it went back for approval
  @Column({ type: 'boolean', default: false, nullable: false })
  requiresApproval: boolean;

  @Column({ type: 'jsonb', nullable: false })
  before: PurchaseOrderSnapshot;

  @Column({ type: 'jsonb', nullable: false })
  after: PurchaseOrderSnapshot;

  // The revision was sent back by the approver: the order returned to `before`
  @Column({ type: 'timestamptz', nullable: true })
  rejectedAt: Date | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_purchase_order_revisions_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => PurchaseOrder, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'purchaseOrderId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_purchase_order_revisions_order',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  purchaseOrder: PurchaseOrder;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'fk_purchase_order_revisions_user',
  })
  user: User;
}
