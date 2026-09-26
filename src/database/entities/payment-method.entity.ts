import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';

export enum PaymentMethodType {
  CASH = 'cash',
  CARD = 'card',
  MOBILE = 'mobile',
  BANK_TRANSFER = 'bank_transfer',
  CHECK = 'check',
  STORE_CREDIT = 'store_credit',
  GIFT_CARD = 'gift_card',
  // Charged to the customer's account (customer credit ledger)
  ON_ACCOUNT = 'on_account',
  OTHER = 'other',
}

export enum PaymentMethodStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

@Entity('payment_methods')
@Unique('uq_payment_method_code', ['tenantId', 'code'])
@Index(['tenantId'])
export class PaymentMethod extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'jsonb', nullable: false })
  name: Record<string, string>;

  @Column({
    type: 'enum',
    enum: PaymentMethodType,
    nullable: false,
  })
  methodType: PaymentMethodType;

  @Column({ type: 'boolean', default: false, nullable: false })
  requiresReference: boolean;

  @Column({ type: 'boolean', default: true, nullable: false })
  opensDrawer: boolean;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  settings: Record<string, any>;

  // Payment provider adapter (src/payments/providers): 'manual' = cashier confirms the
  // terminal's approval code; others are integrated terminals/gateways
  @Column({ type: 'varchar', length: 50, default: 'manual', nullable: false })
  provider: string;

  @Column({
    type: 'enum',
    enum: PaymentMethodStatus,
    default: PaymentMethodStatus.ACTIVE,
    nullable: false,
  })
  status: PaymentMethodStatus;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;
}
