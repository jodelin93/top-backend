import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Shift } from './shift.entity';
import { User } from './user.entity';

/**
 * What a correction changes on a closed shift (the shift itself stays frozen):
 * - expected: the expected cash was wrong (e.g. a paid-out nobody recorded)
 * - counted: the drawer was recounted and held a different amount
 * The amount is signed: + raises, − lowers the corrected figure.
 */
export enum ShiftCorrectionType {
  EXPECTED = 'expected',
  COUNTED = 'counted',
}

/**
 * A manager's correction of a closed shift, linked to it instead of reopening it.
 * Shown on the Z-report as a supplement next to the frozen figures.
 */
@Entity('shift_corrections')
@Index('IDX_shift_corrections_shift', ['tenantId', 'shiftId'])
@Check('CHK_shift_corrections_type', `"type" IN ('expected', 'counted')`)
@Check('CHK_shift_corrections_amount', `"amount" <> 0`)
export class ShiftCorrection extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  shiftId: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  type: ShiftCorrectionType;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  amount: number;

  @Column({ type: 'varchar', length: 500, nullable: false })
  reason: string;

  @Column({ type: 'uuid', nullable: false })
  createdById: string;

  // The manager who approved it (the creator when they hold shifts.manage)
  @Column({ type: 'uuid', nullable: false })
  approvedById: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_shift_corrections_tenant',
  })
  tenant?: Tenant;

  @ManyToOne(() => Shift, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'shiftId',
    foreignKeyConstraintName: 'FK_shift_corrections_shift',
  })
  shift?: Shift;

  @ManyToOne(() => User, { onDelete: 'NO ACTION' })
  @JoinColumn({
    name: 'approvedById',
    foreignKeyConstraintName: 'FK_shift_corrections_approved_by',
  })
  approvedBy?: User;
}
