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
import { Supplier } from './supplier.entity';
import { PurchaseOrder } from './purchase-order.entity';
import { User } from './user.entity';
import { SupplierInvoiceItem } from './supplier-invoice-item.entity';

export type SupplierInvoiceType = 'standard' | 'opening_balance';

// pending_approval: a line's price or quantity variance is above the tolerance.
// open: approved (automatically or by purchasing.approve); can be paid.
export type SupplierInvoiceStatus = 'pending_approval' | 'open' | 'void';

/**
 * A supplier's bill (accounts payable). Lines are matched to purchase order
 * lines (3-way match: ordered price, received quantity, invoiced). What is
 * still owed is derived from payment and credit allocations, never stored.
 * The same invoice number cannot be entered twice for a supplier (unless void).
 */
@Entity('supplier_invoices')
@Unique('uq_supplier_invoices_id_tenant', ['id', 'tenantId'])
@Index('idx_supplier_invoices_supplier', ['tenantId', 'supplierId'])
@Index('idx_supplier_invoices_due', ['tenantId', 'dueDate'])
export class SupplierInvoice extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  supplierId: string;

  // The supplier's invoice number
  @Column({ type: 'varchar', length: 100, nullable: false })
  invoiceNumber: string;

  @Column({ type: 'varchar', length: 20, default: 'standard', nullable: false })
  invoiceType: SupplierInvoiceType;

  @Column({ type: 'uuid', nullable: true })
  purchaseOrderId: string | null;

  @Column({ type: 'date', nullable: false })
  invoiceDate: string;

  @Column({ type: 'date', nullable: false })
  dueDate: string;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  // Lines net of tax
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

  @Column({
    type: 'varchar',
    length: 20,
    default: 'pending_approval',
    nullable: false,
  })
  status: SupplierInvoiceStatus;

  // At least one line is outside the match tolerance
  @Column({ type: 'boolean', default: false, nullable: false })
  hasVariance: boolean;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @Column({ type: 'uuid', nullable: true })
  approvedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  voidedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  voidReason: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_supplier_invoices_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'supplierId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_invoices_supplier',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  supplier: Supplier;

  @ManyToOne(() => PurchaseOrder, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'purchaseOrderId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_invoices_purchase_order',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  purchaseOrder: PurchaseOrder | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'fk_supplier_invoices_user',
  })
  user: User;

  @OneToMany(() => SupplierInvoiceItem, (item) => item.invoice)
  items: SupplierInvoiceItem[];
}
