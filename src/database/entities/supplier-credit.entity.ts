import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Supplier } from './supplier.entity';
import { SupplierReturn } from './supplier-return.entity';
import { User } from './user.entity';

export type SupplierCreditType = 'return' | 'manual';
export type SupplierCreditStatus = 'open' | 'void';

/**
 * Money the supplier owes back (credit note): from a supplier return or entered
 * by hand. Reduces the supplier balance; can be allocated to invoices.
 */
@Entity('supplier_credits')
@Unique('uq_supplier_credits_number', ['tenantId', 'creditNumber'])
@Unique('uq_supplier_credits_id_tenant', ['id', 'tenantId'])
@Index('idx_supplier_credits_supplier', ['tenantId', 'supplierId'])
export class SupplierCredit extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  // SC-000001
  @Column({ type: 'varchar', length: 50, nullable: false })
  creditNumber: string;

  @Column({ type: 'uuid', nullable: false })
  supplierId: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  creditType: SupplierCreditType;

  @Column({ type: 'uuid', nullable: true })
  returnId: string | null;

  @Column({ type: 'date', nullable: false })
  creditDate: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  amount: number;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  // Supplier's credit note number
  @Column({ type: 'varchar', length: 100, nullable: true })
  reference: string | null;

  @Column({ type: 'varchar', length: 500, nullable: false })
  reason: string;

  @Column({ type: 'varchar', length: 20, default: 'open', nullable: false })
  status: SupplierCreditStatus;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_supplier_credits_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'supplierId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_credits_supplier',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  supplier: Supplier;

  @ManyToOne(() => SupplierReturn, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'returnId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_credits_return',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  supplierReturn: SupplierReturn | null;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'fk_supplier_credits_user',
  })
  user: User;
}
