import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Payment } from './payment.entity';
import { SettlementBatch } from './settlement-batch.entity';

export enum SettlementLineStatus {
  MATCHED = 'matched',
  UNMATCHED = 'unmatched',
  RESOLVED = 'resolved',
}

/**
 * One settled transaction in a settlement batch, matched to a captured payment
 */
@Entity('settlement_lines')
@Index('IDX_settlement_lines_tenant_status', ['tenantId', 'status'])
@Index('IDX_settlement_lines_batch', ['batchId'])
@Index('uq_settlement_line_payment', ['paymentId'], {
  unique: true,
  where: '"paymentId" IS NOT NULL',
})
export class SettlementLine extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  batchId: string;

  // Provider reference / terminal approval code of the settled transaction
  @Column({ type: 'varchar', length: 255, nullable: false })
  reference: string;

  // Gross amount of the transaction
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  amount: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  fee: number;

  @Column({ type: 'date', nullable: true })
  settledDate: string | null;

  @Column({
    type: 'varchar',
    length: 20,
    default: SettlementLineStatus.UNMATCHED,
    nullable: false,
  })
  status: SettlementLineStatus;

  @Column({ type: 'uuid', nullable: true })
  paymentId: string | null;

  @Column({ type: 'uuid', nullable: true })
  resolvedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  resolutionNote: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_settlement_lines_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => SettlementBatch, (batch) => batch.lines, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'batchId',
    foreignKeyConstraintName: 'FK_settlement_lines_batch',
  })
  batch: SettlementBatch;

  @ManyToOne(() => Payment, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'paymentId',
    foreignKeyConstraintName: 'FK_settlement_lines_payment',
  })
  payment: Payment | null;
}
