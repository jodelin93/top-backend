import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { Tenant } from './tenant.entity';
import { PriceList } from './price-list.entity';

/**
 * A group of customers (e.g. "Staff", "Wholesale") with an optional default
 * price list and discount. Pricing doesn't apply these yet; they are stored for the POS.
 */
@Entity('customer_groups')
@Unique('uq_customer_group_code', ['tenantId', 'code'])
@Index('IDX_customer_groups_tenant', ['tenantId'])
@Check(
  'CHK_customer_groups_discount',
  '"discountPercent" >= 0 AND "discountPercent" <= 100',
)
export class CustomerGroup {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_customer_groups',
  })
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  // Optimistic concurrency for admin edits (If-Match)
  @VersionColumn({ name: 'version', type: 'int', default: 1 })
  version: number;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @Column({ type: 'uuid', nullable: true })
  priceListId: string | null;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
    nullable: false,
  })
  discountPercent: number;

  @Column({ type: 'boolean', default: true, nullable: false })
  isActive: boolean;

  // Payment terms (days) for members' sales on account, unless set on the customer
  @Column({ type: 'int', nullable: true })
  defaultPaymentTermDays: number | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_customer_groups_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => PriceList, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'priceListId',
    foreignKeyConstraintName: 'FK_customer_groups_price_list',
  })
  priceList: PriceList | null;
}
