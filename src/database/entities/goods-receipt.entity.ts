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
import { PurchaseOrder } from './purchase-order.entity';
import { Supplier } from './supplier.entity';
import { InventoryLocation } from './inventory-location.entity';
import { User } from './user.entity';
import { GoodsReceiptItem } from './goods-receipt-item.entity';

/**
 * One delivery received against a purchase order (R072/R073). A PO can have
 * several (partial deliveries). Unplanned receipts have a supplier but no PO.
 * The idempotency key makes a retried submission return the first receipt
 * instead of posting the stock twice.
 */
@Entity('goods_receipts')
@Unique('uq_goods_receipts_number', ['tenantId', 'receiptNumber'])
@Unique('uq_goods_receipts_idempotency', ['tenantId', 'idempotencyKey'])
@Unique('uq_goods_receipts_id_tenant', ['id', 'tenantId'])
@Index('idx_goods_receipts_purchase_order', ['purchaseOrderId'])
@Index('idx_goods_receipts_supplier', ['tenantId', 'supplierId'])
export class GoodsReceipt extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  // GRN-000001
  @Column({ type: 'varchar', length: 50, nullable: false })
  receiptNumber: string;

  // Null for an unplanned receipt (no purchase order)
  @Column({ type: 'uuid', nullable: true })
  purchaseOrderId: string | null;

  @Column({ type: 'uuid', nullable: false })
  supplierId: string;

  @Column({ type: 'uuid', nullable: false })
  locationId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  idempotencyKey: string;

  @Column({
    type: 'timestamptz',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  receivedAt: Date;

  // Supplier delivery note / invoice number
  @Column({ type: 'varchar', length: 100, nullable: true })
  reference: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  totalCost: number;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  // Who authorised receiving more than the over-receipt tolerance
  @Column({ type: 'uuid', nullable: true })
  overReceiptApprovedById: string | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_goods_receipts_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => PurchaseOrder, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'purchaseOrderId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_goods_receipts_purchase_order',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  purchaseOrder: PurchaseOrder | null;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'supplierId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_goods_receipts_supplier',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  supplier: Supplier;

  @ManyToOne(() => InventoryLocation, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'locationId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_goods_receipts_location',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  location: InventoryLocation;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'fk_goods_receipts_user',
  })
  user: User;

  @OneToMany(() => GoodsReceiptItem, (item) => item.receipt)
  items: GoodsReceiptItem[];
}
