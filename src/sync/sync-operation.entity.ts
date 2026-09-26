import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../database/entities/base.entity';
import { Tenant } from '../database/entities/tenant.entity';

export enum SyncOperationStatus {
  // Applied (a sale exists for it)
  ACCEPTED = 'accepted',
  // Could not be applied; the till keeps it and shows the reason
  NEEDS_REVIEW = 'needs_review',
}

/**
 * One operation a till pushed through POST /sync/push (spec §19): the per-op
 * acknowledgement the server gave, keyed by the device's operation id, so a
 * resent batch (lost acknowledgement) is answered from here.
 */
@Entity('sync_operations')
@Index('uq_sync_operations_op', ['tenantId', 'deviceOperationId'], {
  unique: true,
})
@Index('IDX_sync_operations_device', ['tenantId', 'deviceId', 'status'])
@Index('IDX_sync_operations_lease', ['tenantId', 'leaseId', 'deviceSequence'], {
  where: '"leaseId" IS NOT NULL',
})
export class SyncOperation extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: true })
  deviceId: string | null;

  // Client-generated id (for sales: the sale's idempotency key)
  @Column({ type: 'varchar', length: 100, nullable: false })
  deviceOperationId: string;

  @Column({ type: 'int', nullable: true })
  deviceSequence: number | null;

  // 'sale.create' for now
  @Column({ type: 'varchar', length: 30, nullable: false })
  opType: string;

  @Column({ type: 'int', nullable: false, default: 1 })
  schemaVersion: number;

  // sha256 of the canonical payload, as computed by the till
  @Column({ type: 'varchar', length: 64, nullable: false })
  payloadHash: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  status: SyncOperationStatus;

  @Column({ type: 'uuid', nullable: true })
  saleId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  // Offline lease the sale was captured under (limits are counted per lease)
  @Column({ type: 'uuid', nullable: true })
  leaseId: string | null;

  // Why the sale falls outside its lease (see offline-lease.ts); [] = within it
  @Column({ type: 'jsonb', nullable: false, default: [] })
  leaseIssues: string[];

  // Sale total, for the per-lease total limit
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    nullable: false,
    default: 0,
    transformer: {
      to: (value: number) => value,
      from: (value: string | null) => Number(value ?? 0),
    },
  })
  amount: number;

  @Column({ type: 'timestamptz', nullable: true })
  capturedAt: Date | null;

  // Cashier who rang it up (as reported by the till)
  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

  // Pricing / policy snapshot the till used (tax, discounts, rates, settings version)
  @Column({ type: 'jsonb', nullable: true })
  snapshot: Record<string, unknown> | null;

  // Set when an administrator imported the operation from an export file
  @Column({ type: 'uuid', nullable: true })
  importedBy: string | null;

  @Column({ type: 'int', nullable: false, default: 1 })
  attempts: number;

  @Column({
    type: 'timestamptz',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  lastAttemptAt: Date;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_sync_operations_tenant',
  })
  tenant?: Tenant;
}
