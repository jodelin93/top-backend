import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  Unique,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Sale } from './sale.entity';
import { SaleReturnItem } from './sale-return-item.entity';
import { SaleReturnRefund } from './sale-return-refund.entity';

export enum ReturnStatus {
  // All refunds settled
  COMPLETED = 'completed',
  // Stock and records posted; a card refund is still waiting on the provider
  REFUND_PENDING = 'refund_pending',
  // A card refund failed and must be retried or refunded another way
  REFUND_FAILED = 'refund_failed',
}

export enum ReturnType {
  // Goods brought back
  RETURN = 'return',
  // Money refunded without goods (reason and approval required, no stock movement)
  GOODWILL = 'goodwill',
  // Goods brought back and exchanged for a new sale (see exchange_links)
  EXCHANGE = 'exchange',
}

/**
 * A return of items from an earlier sale (R090). Amounts are the refund, taken from
 * the original sale's price/discount/tax snapshot.
 */
@Entity('sale_returns')
@Unique('uq_return_number', ['tenantId', 'returnNumber'])
@Index('IDX_returns_tenant_created', ['tenantId', 'createdAt'])
@Index('IDX_returns_sale', ['originalSaleId'])
@Index('uq_return_idempotency', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
export class SaleReturn extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  returnNumber: string;

  @Column({ type: 'uuid', nullable: false })
  originalSaleId: string;

  // Where the return was processed (cash refunds come out of this register's shift)
  @Column({ type: 'uuid', nullable: false })
  registerId: string;

  @Column({ type: 'uuid', nullable: true })
  shiftId: string | null;

  @Column({ type: 'uuid', nullable: true })
  customerId: string | null;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  // Manager who approved a return outside the return window
  @Column({ type: 'uuid', nullable: true })
  approverId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: false })
  reason: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  subtotal: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  discountAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  taxAmount: number;

  // Amount refunded to the customer
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  total: number;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  @Column({
    type: 'enum',
    enum: ReturnStatus,
    default: ReturnStatus.COMPLETED,
    nullable: false,
  })
  status: ReturnStatus;

  @Column({ type: 'varchar', length: 100, nullable: true })
  idempotencyKey: string | null;

  @Column({
    type: 'enum',
    enum: ReturnType,
    enumName: 'sale_returns_returntype_enum',
    default: ReturnType.RETURN,
    nullable: false,
  })
  returnType: ReturnType;

  @ManyToOne(() => Sale, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'originalSaleId',
    foreignKeyConstraintName: 'FK_returns_sale',
  })
  originalSale: Sale;

  @OneToMany(() => SaleReturnItem, (item) => item.saleReturn)
  items: SaleReturnItem[];

  @OneToMany(() => SaleReturnRefund, (refund) => refund.saleReturn)
  refunds: SaleReturnRefund[];
}
