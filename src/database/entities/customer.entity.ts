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
import { Sale } from './sale.entity';
import { CustomerGroup } from './customer-group.entity';

export enum CustomerType {
  INDIVIDUAL = 'individual',
  BUSINESS = 'business',
}

export enum CustomerStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  BLOCKED = 'blocked',
}

@Entity('customers')
@Unique('uq_customer_code', ['tenantId', 'code'])
@Index(['tenantId'])
@Index(['email'])
@Index(['phone'])
@Index('IDX_customers_group', ['groupId'])
// Expression indexes created by migration (duplicate detection); not managed by TypeORM
@Index('IDX_customers_email_norm', { synchronize: false })
@Index('IDX_customers_phone_norm', { synchronize: false })
@Index('IDX_customers_name_trgm', { synchronize: false })
export class Customer extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({
    type: 'enum',
    enum: CustomerType,
    default: CustomerType.INDIVIDUAL,
    nullable: false,
  })
  customerType: CustomerType;

  @Column({ type: 'varchar', length: 255, nullable: true })
  firstName: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  lastName: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  companyName: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  taxNumber: string;

  @Column({ type: 'date', nullable: true })
  dateOfBirth: Date;

  @Column({ type: 'varchar', length: 10, nullable: true })
  locale: string;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  creditLimit: number;

  // Projection of the customer account ledger (customer_credit_entries): only
  // CustomerCreditService changes it, in the same transaction as the entry
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  currentBalance: number;

  // Days to pay a charge on account; null: the group's default terms, else 30
  @Column({ type: 'int', nullable: true })
  paymentTermDays: number | null;

  // No new sales on account while set (payments are still taken)
  @Column({ type: 'boolean', default: false, nullable: false })
  creditHold: boolean;

  @Column({ type: 'int', default: 0, nullable: false })
  loyaltyPoints: number;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  metadata: Record<string, any>;

  @Column({
    type: 'enum',
    enum: CustomerStatus,
    default: CustomerStatus.ACTIVE,
    nullable: false,
  })
  status: CustomerStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastPurchaseAt: Date;

  @Column({ type: 'uuid', nullable: true })
  groupId: string | null;

  // Marketing consent; every change is also appended to customer_consent_events
  @Column({ type: 'boolean', default: false, nullable: false })
  marketingEmailConsent: boolean;

  @Column({ type: 'boolean', default: false, nullable: false })
  marketingSmsConsent: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  consentUpdatedAt: Date | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  consentSource: string | null;

  // Set when this record was merged into another customer (it is then inactive)
  @Column({ type: 'uuid', nullable: true })
  mergedIntoId: string | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => CustomerGroup, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'groupId',
    foreignKeyConstraintName: 'FK_customers_group',
  })
  group: CustomerGroup | null;

  @ManyToOne(() => Customer, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'mergedIntoId',
    foreignKeyConstraintName: 'FK_customers_merged_into',
  })
  mergedInto: Customer | null;

  @OneToMany(() => Sale, (sale) => sale.customer)
  sales: Sale[];
}
