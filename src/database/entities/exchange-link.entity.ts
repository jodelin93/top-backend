import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { SaleReturn } from './sale-return.entity';

export enum ExchangeStatus {
  // Return recorded, replacement sale being rung up
  PENDING = 'pending',
  COMPLETED = 'completed',
  // The replacement sale failed: the return stands, the credit is still owed
  INCOMPLETE = 'incomplete',
  // Given up: the credit was refunded instead (no replacement sale)
  CANCELLED = 'cancelled',
}

/**
 * An exchange (spec §12): a return plus a replacement sale. The returned value
 * (creditAmount) pays for the new sale through the EXCHANGE_CREDIT tender; a
 * difference is charged with other tenders or refunded on the return.
 */
@Entity('exchange_links')
@Index('uq_exchange_return', ['returnId'], { unique: true })
@Index('IDX_exchange_new_sale', ['newSaleId'], {
  where: '"newSaleId" IS NOT NULL',
})
@Index('IDX_exchange_tenant_status', ['tenantId', 'status'])
export class ExchangeLink extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  originalSaleId: string;

  @Column({ type: 'uuid', nullable: false })
  returnId: string;

  @Column({ type: 'uuid', nullable: true })
  newSaleId: string | null;

  @Column({
    type: 'enum',
    enum: ExchangeStatus,
    enumName: 'exchange_links_status_enum',
    default: ExchangeStatus.PENDING,
    nullable: false,
  })
  status: ExchangeStatus;

  // Value of the returned goods
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  returnTotal: number;

  // Part of it that pays for the replacement sale
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  creditAmount: number;

  // Replacement sale total as quoted when the exchange started
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  newSaleTotal: number;

  // Signed: + the customer paid the difference, − it was refunded to them
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  difference: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  failureReason: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdById: string | null;

  @ManyToOne(() => SaleReturn, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'returnId',
    foreignKeyConstraintName: 'FK_exchange_links_return',
  })
  saleReturn?: SaleReturn;
}
