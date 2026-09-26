import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from '../database/entities/base.entity';
import { Tenant } from '../database/entities/tenant.entity';

/**
 * A till (browser) registered by the POS. It reports its offline queue through
 * heartbeats and holds an offline lease that limits how long it may sell offline.
 */
@Entity('devices')
@Index('IDX_devices_tenant', ['tenantId'])
export class Device extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  // 'pos' today; room for e.g. 'kiosk' or 'handheld'
  @Column({ type: 'varchar', length: 20, nullable: false, default: 'pos' })
  type: string;

  // Register the till last worked on
  @Column({ type: 'uuid', nullable: true })
  registerId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  appVersion: string | null;

  @Column({
    type: 'timestamptz',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  registeredAt: Date;

  @Column({ type: 'uuid', nullable: true })
  registeredBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  lastSeenAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  lastSeenBy: string | null;

  // Last time the till finished uploading its queue / refreshing its data
  @Column({ type: 'timestamptz', nullable: true })
  lastSyncAt: Date | null;

  // Offline sales waiting on the device (as of the last heartbeat)
  @Column({ type: 'int', nullable: false, default: 0 })
  pendingSales: number;

  // Of those, sales the server rejected (need a manager's review)
  @Column({ type: 'int', nullable: false, default: 0 })
  failedSales: number;

  // Highest deviceSequence the device has handed out
  @Column({ type: 'int', nullable: false, default: 0 })
  lastSequence: number;

  // The device may sell offline until this time
  @Column({ type: 'timestamptz', nullable: true })
  leaseExpiresAt: Date | null;

  // When the current signed offline lease was issued (spec §19)
  @Column({ type: 'timestamptz', nullable: true })
  leaseIssuedAt: Date | null;

  // Sync queue as of the last heartbeat (sync dashboard): capture time of the
  // oldest unsynced operation, value of the unsynced sales and upload retries
  @Column({ type: 'timestamptz', nullable: true })
  oldestPendingAt: Date | null;

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
  pendingAmount: number;

  @Column({ type: 'int', nullable: false, default: 0 })
  syncRetries: number;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  revokedBy: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  revokedReason: string | null;

  // Marked lost / abandoned: revoked for good, every further sync is refused
  @Column({ type: 'timestamptz', nullable: true })
  lostAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  lostBy: string | null;

  // Sales the till still held when it was lost (queued + never received)
  @Column({ type: 'int', nullable: true })
  lostUnsyncedCount: number | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_devices_tenant',
  })
  tenant?: Tenant;
}
