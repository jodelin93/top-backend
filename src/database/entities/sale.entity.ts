import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
  OneToMany,
} from 'typeorm';
import { BaseEntityWithVersion } from './base.entity';
import { Tenant } from './tenant.entity';
import { Branch } from './branch.entity';
import { Register } from './register.entity';
import { Customer } from './customer.entity';
import { User } from './user.entity';
import { SaleItem } from './sale-item.entity';
import { Payment } from './payment.entity';
import type { SaleDocumentSnapshot } from '../../sales/document-snapshot';

/**
 * Sale lifecycle. Allowed transitions live in src/sales/sale-lifecycle.ts.
 *   draft ─┬─> held ──> (resume) draft
 *          ├─> payment_pending ──> completed | cancelled
 *          ├─> completed ──> voided | partially_refunded | refunded
 *          └─> cancelled
 */
export enum SaleStatus {
  DRAFT = 'draft',
  HELD = 'held',
  PAYMENT_PENDING = 'payment_pending',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  VOIDED = 'voided',
  REFUNDED = 'refunded',
  PARTIALLY_REFUNDED = 'partially_refunded',
}

export enum SaleType {
  REGULAR = 'regular',
  RETURN = 'return',
  EXCHANGE = 'exchange',
}

@Entity('sales')
@Unique('uq_sale_number', ['tenantId', 'saleNumber'])
@Unique('uq_sale_id_tenant', ['id', 'tenantId'])
@Index(['tenantId'])
@Index(['branchId'])
@Index(['registerId'])
@Index(['customerId'])
@Index(['status'])
@Index(['saleDate'])
@Index('IDX_sales_tenant_status_register', ['tenantId', 'status', 'registerId'])
@Index('IDX_sales_tenant_shift', ['tenantId', 'shiftId'], {
  where: '"shiftId" IS NOT NULL',
})
@Index('IDX_sales_tenant_offline_number', ['tenantId', 'offlineNumber'], {
  where: '"offlineNumber" IS NOT NULL',
})
@Index('IDX_sales_tenant_salesperson', ['tenantId', 'salespersonId'], {
  where: '"salespersonId" IS NOT NULL',
})
@Index('IDX_sales_tenant_device', ['tenantId', 'deviceId', 'deviceSequence'], {
  where: '"deviceId" IS NOT NULL',
})
// Retried or offline-synced submissions must never create a second sale
@Index('uq_sale_idempotency', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
export class Sale extends BaseEntityWithVersion {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  saleNumber: string;

  @Column({ type: 'uuid', nullable: false })
  branchId: string;

  @Column({ type: 'uuid', nullable: false })
  registerId: string;

  @Column({ type: 'uuid', nullable: true })
  customerId: string;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @Column({
    type: 'enum',
    enum: SaleType,
    default: SaleType.REGULAR,
    nullable: false,
  })
  saleType: SaleType;

  @Column({
    type: 'timestamptz',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  saleDate: Date;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  subtotal: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  taxAmount: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  discountAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  total: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  amountPaid: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  changeAmount: number;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  notes: string;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  metadata: Record<string, any>;

  @Column({
    type: 'enum',
    enum: SaleStatus,
    default: SaleStatus.DRAFT,
    nullable: false,
  })
  status: SaleStatus;

  @Column({ type: 'uuid', nullable: true })
  parentSaleId: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  idempotencyKey: string;

  // Register shift the sale was rung up in (shifts module)
  @Column({ type: 'uuid', nullable: true })
  shiftId: string | null;

  // Provisional number printed on the receipt when the sale was rung up offline
  @Column({ type: 'varchar', length: 50, nullable: true })
  offlineNumber: string | null;

  // Device that recorded the sale and its per-device sequence (offline sync)
  @Column({ type: 'uuid', nullable: true })
  deviceId: string | null;

  @Column({ type: 'int', nullable: true })
  deviceSequence: number | null;

  // Receipt copies printed after the original ("COPY" receipts)
  @Column({ type: 'int', default: 0, nullable: false })
  receiptPrintCount: number;

  // Held carts: when the hold (and its stock reservation) lapses, and a label for the list
  @Column({ type: 'timestamptz', nullable: true })
  heldUntil: Date | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  heldLabel: string | null;

  // Staff member credited with the sale (commission, reports); the cashier is userId
  @Column({ type: 'uuid', nullable: true })
  salespersonId: string | null;

  // Seller identity printed on the receipt, frozen when the sale completed so
  // reprints never change with the settings (see src/sales/document-snapshot.ts)
  @Column({ type: 'jsonb', nullable: true })
  documentSnapshot: SaleDocumentSnapshot | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => Branch, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'branchId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  branch: Branch;

  @ManyToOne(() => Register, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'registerId' })
  register: Register;

  @ManyToOne(() => Customer, (customer) => customer.sales, {
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'customerId' })
  customer: Customer;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'userId' })
  user: User;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'salespersonId',
    foreignKeyConstraintName: 'FK_sales_salesperson',
  })
  salesperson?: User | null;

  @ManyToOne(() => Sale, { onDelete: 'SET NULL' })
  @JoinColumn([
    { name: 'parentSaleId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  parentSale: Sale;

  @OneToMany(() => SaleItem, (item) => item.sale)
  items: SaleItem[];

  @OneToMany(() => Payment, (payment) => payment.sale)
  payments: Payment[];
}
