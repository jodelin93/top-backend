import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Sale } from './sale.entity';
import { PaymentMethod } from './payment-method.entity';

/**
 * Payment states. Cash and manually confirmed card payments are `completed` at once;
 * provider payments follow initiated → pending → authorized → captured (or failed,
 * cancelled, unknown after a timeout). Transitions: src/payments/payment-state.ts.
 */
export enum PaymentStatus {
  INITIATED = 'initiated',
  PENDING = 'pending',
  AUTHORIZED = 'authorized',
  CAPTURED = 'captured',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  UNKNOWN = 'unknown',
  REFUNDED = 'refunded',
}

@Entity('payments')
@Index(['tenantId'])
@Index(['saleId'])
@Index(['paymentMethodId'])
@Index(['status'])
@Index(['paymentDate'])
@Index('uq_payment_idempotency', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
@Index('uq_payment_provider_reference', ['provider', 'providerReference'], {
  unique: true,
  where: '"providerReference" IS NOT NULL',
})
export class Payment extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  saleId: string;

  @Column({ type: 'uuid', nullable: false })
  paymentMethodId: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  amount: number;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  // Paid in another currency than the sale's: what the customer handed over and the
  // rate used (units of tenderedCurrency per 1 unit of currencyCode). amount is always
  // in the sale currency. Null when paid in the sale currency.
  @Column({ type: 'char', length: 3, nullable: true })
  tenderedCurrency: string | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  tenderedAmount: number | null;

  @Column({ type: 'numeric', precision: 19, scale: 8, nullable: true })
  exchangeRate: number | null;

  @Column({
    type: 'timestamptz',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  paymentDate: Date;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reference: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  notes: string;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  metadata: Record<string, any>;

  @Column({
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.COMPLETED,
    nullable: false,
  })
  status: PaymentStatus;

  // One key per payment attempt; the provider receives it so retries never double-charge
  @Column({ type: 'varchar', length: 100, nullable: true })
  idempotencyKey: string;

  // Payment provider adapter (null for cash and legacy rows)
  @Column({ type: 'varchar', length: 50, nullable: true })
  provider: string | null;

  // The provider's id for this payment (intent/transaction id)
  @Column({ type: 'varchar', length: 255, nullable: true })
  providerReference: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  failureReason: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  authorizedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  capturedAt: Date | null;

  // Last status lookup at the provider (timeouts / unknown states)
  @Column({ type: 'timestamptz', nullable: true })
  lastCheckedAt: Date | null;

  // Set when the payment was matched to a settlement line or resolved by hand
  @Column({ type: 'timestamptz', nullable: true })
  reconciledAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reconciliationNote: string | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => Sale, (sale) => sale.payments, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'saleId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  sale: Sale;

  @ManyToOne(() => PaymentMethod, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'paymentMethodId' })
  paymentMethod: PaymentMethod;
}
