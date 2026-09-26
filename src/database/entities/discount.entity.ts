import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';

export enum DiscountType {
  PERCENTAGE = 'percentage',
  FIXED_AMOUNT = 'fixed_amount',
  BUY_X_GET_Y = 'buy_x_get_y',
}

export enum DiscountScope {
  PRODUCT = 'product',
  CATEGORY = 'category',
  CART = 'cart',
}

export enum DiscountStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SCHEDULED = 'scheduled',
  EXPIRED = 'expired',
}

@Entity('discounts')
@Unique('uq_discount_code', ['tenantId', 'code'])
@Index(['tenantId'])
@Index(['scope'])
@Index(['validFrom'])
@Index(['validTo'])
export class Discount extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'jsonb', nullable: false })
  name: Record<string, string>;

  @Column({ type: 'jsonb', nullable: true })
  description: Record<string, string>;

  @Column({
    type: 'enum',
    enum: DiscountType,
    nullable: false,
  })
  discountType: DiscountType;

  @Column({
    type: 'enum',
    enum: DiscountScope,
    nullable: false,
  })
  scope: DiscountScope;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  value: number;

  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  percentage: number;

  @Column({ type: 'int', nullable: true })
  buyQuantity: number;

  @Column({ type: 'int', nullable: true })
  getQuantity: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  minPurchaseAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  maxDiscountAmount: number;

  @Column({ type: 'int', nullable: true })
  usageLimit: number;

  @Column({ type: 'int', default: 0, nullable: false })
  usageCount: number;

  @Column({ type: 'int', nullable: true })
  usageLimitPerCustomer: number;

  @Column({ type: 'timestamptz', nullable: true })
  validFrom: Date;

  @Column({ type: 'timestamptz', nullable: true })
  validTo: Date;

  @Column({ type: 'jsonb', default: [], nullable: false })
  applicableProductIds: string[];

  @Column({ type: 'jsonb', default: [], nullable: false })
  applicableCategoryIds: string[];

  @Column({ type: 'jsonb', default: [], nullable: false })
  excludedProductIds: string[];

  @Column({ type: 'int', default: 0, nullable: false })
  priority: number;

  @Column({
    type: 'enum',
    enum: DiscountStatus,
    default: DiscountStatus.ACTIVE,
    nullable: false,
  })
  status: DiscountStatus;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;
}
