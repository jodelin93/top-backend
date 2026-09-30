import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Supplier } from './supplier.entity';
import { User } from './user.entity';

export type SupplierPaymentMethod =
  'cash' | 'bank_transfer' | 'check' | 'card' | 'mobile_money' | 'other';
export type SupplierPaymentStatus = 'posted' | 'void';

/**
 * Money paid to a supplier, allocated (fully, partly or not yet) to invoices
 */
@Entity('supplier_payments')
@Unique('uq_supplier_payments_number', ['tenantId', 'paymentNumber'])
@Unique('uq_supplier_payments_id_tenant', ['id', 'tenantId'])
@Index('idx_supplier_payments_supplier', ['tenantId', 'supplierId'])
export class SupplierPayment extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  // SP-000001
  @Column({ type: 'varchar', length: 50, nullable: false })
  paymentNumber: string;

  @Column({ type: 'uuid', nullable: false })
  supplierId: string;

  @Column({ type: 'date', nullable: false })
  paymentDate: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  amount: number;

  // Paid in another currency than the supplier's (e.g. HTG against a USD balance):
  // that currency, the amount paid in it and the rate used (null = same currency)
  @Column({ type: 'varchar', length: 3, nullable: true })
  tenderedCurrency: string | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  tenderedAmount: number | null;

  @Column({ type: 'numeric', precision: 19, scale: 8, nullable: true })
  exchangeRate: number | null;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  method: SupplierPaymentMethod;

  // Cheque / transfer number
  @Column({ type: 'varchar', length: 100, nullable: true })
  reference: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  @Column({ type: 'varchar', length: 20, default: 'posted', nullable: false })
  status: SupplierPaymentStatus;

  @Column({ type: 'timestamptz', nullable: true })
  voidedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  voidReason: string | null;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_supplier_payments_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'supplierId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_payments_supplier',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  supplier: Supplier;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'fk_supplier_payments_user',
  })
  user: User;
}
