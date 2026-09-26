import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { SupplierInvoice } from './supplier-invoice.entity';
import { PurchaseOrderItem } from './purchase-order-item.entity';
import { GoodsReceiptItem } from './goods-receipt-item.entity';

/**
 * An invoice line and its 3-way match result against the order line
 * (price ordered, quantity received and not yet invoiced elsewhere).
 */
@Entity('supplier_invoice_items')
@Index('idx_supplier_invoice_items_invoice', ['invoiceId'])
@Index('idx_supplier_invoice_items_po_item', ['purchaseOrderItemId'])
export class SupplierInvoiceItem extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  invoiceId: string;

  @Column({ type: 'int', nullable: false })
  lineNumber: number;

  // Null for charges not on the order (freight, fees)
  @Column({ type: 'uuid', nullable: true })
  purchaseOrderItemId: string | null;

  @Column({ type: 'uuid', nullable: true })
  receiptItemId: string | null;

  @Column({ type: 'uuid', nullable: true })
  variantId: string | null;

  @Column({ type: 'varchar', length: 255, nullable: false })
  description: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  quantity: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  unitPrice: number;

  // quantity × unit price
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

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  total: number;

  // ---- Match (null when not matched to an order line) ----
  // Net unit cost on the order line
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  expectedUnitPrice: number | null;

  // Received and not yet invoiced when this invoice was entered
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  matchableQuantity: number | null;

  // (unit price − expected) × quantity
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  priceVariance: number;

  @Column({ type: 'numeric', precision: 9, scale: 4, nullable: true })
  priceVariancePercent: number | null;

  // Invoiced − matchable (positive = billed for more than was received)
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  quantityVariance: number;

  // Outside the tolerance: the invoice needs approval
  @Column({ type: 'boolean', default: false, nullable: false })
  varianceFlag: boolean;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_supplier_invoice_items_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => SupplierInvoice, (invoice) => invoice.items, {
    onDelete: 'CASCADE',
  })
  @JoinColumn([
    {
      name: 'invoiceId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_invoice_items_invoice',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  invoice: SupplierInvoice;

  @ManyToOne(() => PurchaseOrderItem, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'purchaseOrderItemId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_invoice_items_po_item',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  purchaseOrderItem: PurchaseOrderItem | null;

  @ManyToOne(() => GoodsReceiptItem, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'receiptItemId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_invoice_items_receipt_item',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  receiptItem: GoodsReceiptItem | null;
}
