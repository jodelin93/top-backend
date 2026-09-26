import { Entity, Column, Index, ManyToOne, JoinColumn, Check } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { SupplierInvoice } from './supplier-invoice.entity';
import { SupplierPayment } from './supplier-payment.entity';
import { SupplierCredit } from './supplier-credit.entity';

/**
 * Part of a payment or credit applied to an invoice. An invoice's open amount
 * is its total minus its allocations; neither side is ever over-allocated.
 */
@Entity('supplier_allocations')
@Check(
  'chk_supplier_allocations_source',
  'num_nonnulls("paymentId", "creditId") = 1',
)
@Check('chk_supplier_allocations_amount', '"amount" > 0')
@Index('idx_supplier_allocations_invoice', ['invoiceId'])
@Index('idx_supplier_allocations_payment', ['paymentId'])
@Index('idx_supplier_allocations_credit', ['creditId'])
@Index('idx_supplier_allocations_supplier', ['tenantId', 'supplierId'])
export class SupplierAllocation extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  supplierId: string;

  @Column({ type: 'uuid', nullable: false })
  invoiceId: string;

  @Column({ type: 'uuid', nullable: true })
  paymentId: string | null;

  @Column({ type: 'uuid', nullable: true })
  creditId: string | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  amount: number;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_supplier_allocations_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => SupplierInvoice, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'invoiceId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_allocations_invoice',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  invoice: SupplierInvoice;

  @ManyToOne(() => SupplierPayment, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'paymentId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_allocations_payment',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  payment: SupplierPayment | null;

  @ManyToOne(() => SupplierCredit, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'creditId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_allocations_credit',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  credit: SupplierCredit | null;
}
