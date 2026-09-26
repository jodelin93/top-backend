import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { SettlementLine } from './settlement-line.entity';

/**
 * One imported settlement report from a card acquirer/provider (CSV or JSON)
 */
@Entity('settlement_batches')
@Index('IDX_settlement_batches_tenant', ['tenantId', 'createdAt'])
export class SettlementBatch extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  provider: string;

  // The acquirer's batch/payout id, if the file has one
  @Column({ type: 'varchar', length: 100, nullable: true })
  reference: string | null;

  @Column({ type: 'varchar', length: 10, nullable: false })
  source: 'csv' | 'json';

  @Column({ type: 'uuid', nullable: true })
  importedById: string | null;

  @Column({ type: 'int', default: 0, nullable: false })
  lineCount: number;

  @Column({ type: 'int', default: 0, nullable: false })
  matchedCount: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  totalAmount: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  totalFees: number;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_settlement_batches_tenant',
  })
  tenant: Tenant;

  @OneToMany(() => SettlementLine, (line) => line.batch)
  lines: SettlementLine[];
}
