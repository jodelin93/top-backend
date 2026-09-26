import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';

export interface SupplierContact {
  name: string;
  email?: string | null;
  phone?: string | null;
  // e.g. Sales, Accounts, Warehouse
  role?: string | null;
}

export enum SupplierStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  BLOCKED = 'blocked',
}

@Entity('suppliers')
@Unique('uq_supplier_code', ['tenantId', 'code'])
@Unique('uq_suppliers_id_tenant', ['id', 'tenantId'])
@Index(['tenantId'])
@Index(['email'])
export class Supplier extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  contactPerson: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  addressLine1: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  addressLine2: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  stateProvince: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  postalCode: string;

  @Column({ type: 'char', length: 2, nullable: true })
  countryCode: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  taxNumber: string;

  // Payment terms: invoice due this many days after delivery (net days)
  @Column({ type: 'int', nullable: true })
  paymentTermDays: number;

  // Usual days between issuing an order and the delivery (expected date default)
  @Column({ type: 'int', nullable: true })
  leadTimeDays: number | null;

  // Currency the supplier invoices in (ISO 4217); defaults to the store currency
  @Column({ type: 'char', length: 3, nullable: true })
  currencyCode: string | null;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  // Contact people (sales rep, accounts, ...)
  @Column({ type: 'jsonb', default: [], nullable: false })
  contacts: SupplierContact[];

  @Column({ type: 'jsonb', default: {}, nullable: false })
  metadata: Record<string, any>;

  @Column({
    type: 'enum',
    enum: SupplierStatus,
    default: SupplierStatus.ACTIVE,
    nullable: false,
  })
  status: SupplierStatus;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;
}
