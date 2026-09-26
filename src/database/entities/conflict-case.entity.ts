import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';

/**
 * Something the system accepted but a person must look at (review queue):
 * - offline_oversell: an offline sale took more units than were in stock (D018:
 *   the goods were handed over, so the sale is kept; fix the stock with a count
 *   or an adjustment)
 * - offline_price: an offline sale gave discounts / prices the cashier was not
 *   allowed to give without a manager, or took a payment at the till's own
 *   exchange rate
 * - late_shift: a sale uploaded after the shift it belongs to was closed
 * - offline_lease: an offline sale outside the till's signed lease (expired or
 *   forged lease, over its limits, clock rolled back); recorded, never dropped
 * - lost_device: a till was marked lost; its unsynced sales may never arrive
 * - offline_no_shift: an offline sale uploaded when no shift was open on its
 *   register, then or now: its cash is in no drawer's count
 */
export enum ConflictCaseType {
  OFFLINE_OVERSELL = 'offline_oversell',
  OFFLINE_PRICE = 'offline_price',
  LATE_SHIFT = 'late_shift',
  OFFLINE_LEASE = 'offline_lease',
  LOST_DEVICE = 'lost_device',
  OFFLINE_NO_SHIFT = 'offline_no_shift',
}

export enum ConflictCaseStatus {
  OPEN = 'open',
  RESOLVED = 'resolved',
  DISMISSED = 'dismissed',
}

@Entity('conflict_cases')
@Check(
  'CHK_conflict_cases_status',
  `"status" IN ('open', 'resolved', 'dismissed')`,
)
@Index('IDX_conflict_cases_tenant_status', ['tenantId', 'status', 'openedAt'])
@Index('IDX_conflict_cases_sale', ['tenantId', 'saleId'], {
  where: '"saleId" IS NOT NULL',
})
export class ConflictCase extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 30, nullable: false })
  type: ConflictCaseType;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: false,
    default: ConflictCaseStatus.OPEN,
  })
  status: ConflictCaseStatus;

  @Column({ type: 'uuid', nullable: true })
  saleId: string | null;

  // Till that recorded the sale
  @Column({ type: 'uuid', nullable: true })
  deviceId: string | null;

  // What happened (numbers, lines, quantities), shown in the review queue
  @Column({ type: 'jsonb', nullable: false, default: {} })
  details: Record<string, any>;

  @Column({
    type: 'timestamptz',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  openedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  resolvedById: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  resolutionNote: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_conflict_cases_tenant',
  })
  tenant?: Tenant;
}
