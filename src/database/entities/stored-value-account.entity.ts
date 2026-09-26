import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntityWithVersion } from './base.entity';
import { Customer } from './customer.entity';

export enum StoredValueType {
  GIFT_CARD = 'gift_card',
  STORE_CREDIT = 'store_credit',
}

export enum StoredValueStatus {
  // Gift card rung up on a sale still waiting for its card payment
  PENDING = 'pending',
  ACTIVE = 'active',
  // Cancelled (sale voided / returned before use) or merged away
  VOID = 'void',
}

/**
 * Gift cards and store credit (spec §11): a liability, not revenue.
 * Gift cards are found by the hash of their code (the code itself is never
 * stored; last4 is kept for display). Store credit belongs to one customer.
 * balance is a projection of the append-only stored_value_entries, changed only
 * by guarded UPDATEs (never below zero, also under concurrent redemptions).
 */
@Entity('stored_value_accounts')
@Index('uq_stored_value_code', ['tenantId', 'codeHash'], {
  unique: true,
  where: '"codeHash" IS NOT NULL',
})
@Index('uq_store_credit_customer', ['tenantId', 'customerId'], {
  unique: true,
  where: `"accountType" = 'store_credit' AND "status" <> 'void'`,
})
@Index('IDX_stored_value_customer', ['tenantId', 'customerId'])
@Index('IDX_stored_value_sale', ['tenantId', 'saleId'], {
  where: '"saleId" IS NOT NULL',
})
@Check('CHK_stored_value_balance', '"balance" >= 0')
export class StoredValueAccount extends BaseEntityWithVersion {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({
    type: 'enum',
    enum: StoredValueType,
    enumName: 'stored_value_accounts_type_enum',
    nullable: false,
  })
  accountType: StoredValueType;

  // sha256 of the tenant id and the normalised gift card code
  @Column({ type: 'varchar', length: 64, nullable: true })
  codeHash: string | null;

  @Column({ type: 'varchar', length: 4, nullable: true })
  last4: string | null;

  @Column({ type: 'uuid', nullable: true })
  customerId: string | null;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  balance: number;

  // Value loaded when the gift card was sold
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  initialAmount: number;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  @Column({
    type: 'enum',
    enum: StoredValueStatus,
    enumName: 'stored_value_accounts_status_enum',
    default: StoredValueStatus.ACTIVE,
    nullable: false,
  })
  status: StoredValueStatus;

  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  // Sale (and line) the gift card was sold on
  @Column({ type: 'uuid', nullable: true })
  saleId: string | null;

  @Column({ type: 'uuid', nullable: true })
  saleItemId: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  metadata: Record<string, any>;

  @ManyToOne(() => Customer, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({
    name: 'customerId',
    foreignKeyConstraintName: 'FK_stored_value_customer',
  })
  customer?: Customer | null;
}
