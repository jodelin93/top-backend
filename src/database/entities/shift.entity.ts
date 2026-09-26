import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseEntityWithVersion } from './base.entity';
import { Tenant } from './tenant.entity';
import { Register } from './register.entity';
import { User } from './user.entity';
import { Drawer } from './drawer.entity';

/**
 * Register shift lifecycle: open (active, selling) → closing (drawer being
 * counted) → closed. Only one non-closed shift per drawer (partial unique index);
 * a register with one drawer therefore has one shift at a time.
 */
export enum ShiftStatus {
  OPEN = 'open',
  CLOSING = 'closing',
  CLOSED = 'closed',
}

export interface DenominationCount {
  value: number;
  quantity: number;
}

export interface ForeignCashCount {
  currencyCode: string;
  expected: number;
  counted: number;
  variance: number;
  // Units per 1 unit of the store currency when the shift closed
  exchangeRate: number | null;
}

@Entity('shifts')
@Unique('uq_shift_number', ['tenantId', 'shiftNumber'])
@Unique('uq_shift_id_tenant', ['id', 'tenantId'])
@Index('IDX_shifts_tenant_opened', ['tenantId', 'openedAt'])
@Index('IDX_shifts_tenant_status', ['tenantId', 'status'])
@Index('IDX_shifts_register', ['registerId'])
// One open (or closing) shift per drawer at a time
@Index('uq_shift_drawer_active', ['tenantId', 'drawerId'], {
  unique: true,
  where: `"status" IN ('open', 'closing')`,
})
@Index('IDX_shifts_business_date', ['tenantId', 'businessDate'])
// A retried close with the same key finds the shift it already closed
@Index('uq_shift_close_idempotency', ['tenantId', 'closeIdempotencyKey'], {
  unique: true,
  where: '"closeIdempotencyKey" IS NOT NULL',
})
export class Shift extends BaseEntityWithVersion {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  shiftNumber: string;

  @Column({ type: 'uuid', nullable: false })
  registerId: string;

  @Column({ type: 'uuid', nullable: true })
  branchId: string | null;

  @Column({ type: 'uuid', nullable: false })
  drawerId: string;

  // Drawer policy 'shared' at open: other cashiers work (and sell) on this shift
  @Column({ type: 'boolean', default: false, nullable: false })
  shared: boolean;

  // Trading day the shift counts for (branch timezone, store businessDayCutoffHour)
  @Column({ type: 'date', nullable: true })
  businessDate: string | null;

  // Handover: the shift this one took over from, and who the drawer was handed to
  @Column({ type: 'uuid', nullable: true })
  previousShiftId: string | null;

  @Column({ type: 'uuid', nullable: true })
  handedOverToId: string | null;

  @Column({
    type: 'enum',
    enum: ShiftStatus,
    enumName: 'shifts_status_enum',
    default: ShiftStatus.OPEN,
    nullable: false,
  })
  status: ShiftStatus;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  @Column({ type: 'uuid', nullable: false })
  openedById: string;

  @Column({ type: 'timestamptz', nullable: false })
  openedAt: Date;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  openingFloat: number;

  @Column({ type: 'jsonb', nullable: true })
  openingDenominations: DenominationCount[] | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  openingNotes: string | null;

  // Cash in other currencies in the drawer at opening (a handover carries the
  // counted foreign cash over); part of the expected foreign cash at close
  @Column({ type: 'jsonb', nullable: true })
  openingForeignCash: { currencyCode: string; amount: number }[] | null;

  // Closing
  @Column({ type: 'boolean', default: false, nullable: false })
  blindCount: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  closingStartedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  closedById: string | null;

  @Column({ type: 'uuid', nullable: true })
  closeApprovedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date | null;

  @Column({ type: 'jsonb', nullable: true })
  closingDenominations: DenominationCount[] | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  countedCash: number | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  expectedCash: number | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  variance: number | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  varianceReason: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  closingNotes: string | null;

  @Column({ type: 'boolean', default: false, nullable: false })
  forceClosed: boolean;

  @Column({ type: 'varchar', length: 100, nullable: true })
  closeIdempotencyKey: string | null;

  // Drawer cash in other currencies at close: one entry per currency taken
  @Column({ type: 'jsonb', nullable: true })
  foreignCash: ForeignCashCount[] | null;

  // Frozen Z-report taken at close, so reprints never change
  @Column({ type: 'jsonb', nullable: true })
  closingSummary: Record<string, unknown> | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_shifts_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => Register, { onDelete: 'NO ACTION' })
  @JoinColumn({
    name: 'registerId',
    foreignKeyConstraintName: 'FK_shifts_register',
  })
  register: Register;

  @ManyToOne(() => Drawer, { onDelete: 'NO ACTION' })
  @JoinColumn({
    name: 'drawerId',
    foreignKeyConstraintName: 'FK_shifts_drawer',
  })
  drawer?: Drawer;

  @ManyToOne(() => User, { onDelete: 'NO ACTION' })
  @JoinColumn({
    name: 'openedById',
    foreignKeyConstraintName: 'FK_shifts_opened_by',
  })
  openedBy: User;

  @ManyToOne(() => User, { onDelete: 'NO ACTION', nullable: true })
  @JoinColumn({
    name: 'closedById',
    foreignKeyConstraintName: 'FK_shifts_closed_by',
  })
  closedBy: User | null;
}
