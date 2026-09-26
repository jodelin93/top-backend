import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { StockTransfer } from './stock-transfer.entity';

export enum StockTransferEventKind {
  DISPATCH = 'dispatch',
  RECEIPT = 'receipt',
  WRITE_OFF = 'write_off',
  RETURN = 'return',
}

/**
 * One dispatch / receipt / write-off / return of a transfer. Its id is part of
 * the ledger movements' source keys, and a repeated idempotency key returns the
 * transfer as it is instead of posting the same event twice.
 */
@Entity('stock_transfer_events')
@Unique('uq_stock_transfer_events_key', [
  'tenantId',
  'transferId',
  'kind',
  'idempotencyKey',
])
@Index('idx_stock_transfer_events_transfer', ['tenantId', 'transferId'])
export class StockTransferEvent extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  transferId: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  kind: StockTransferEventKind;

  // Sent by the client; null = no retry protection
  @Column({ type: 'varchar', length: 100, nullable: true })
  idempotencyKey: string | null;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @Column({ type: 'uuid', nullable: true })
  approverId: string | null;

  // What happened per line, e.g. [{ itemId, variantId, quantity, damaged, missing }]
  @Column({ type: 'jsonb', default: [], nullable: false })
  lines: Record<string, unknown>[];

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_stock_transfer_events_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => StockTransfer, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'transferId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_stock_transfer_events_transfer',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  transfer: StockTransfer;
}
