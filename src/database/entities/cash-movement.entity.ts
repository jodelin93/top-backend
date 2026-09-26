import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Shift } from './shift.entity';
import { User } from './user.entity';
import { Expense } from './expense.entity';

/**
 * Cash drawer ledger per shift. Amounts are always positive; the type decides
 * whether the movement adds to (opening_float, paid_in) or takes from the drawer.
 * Cash sales are computed from sales/payments for the expected cash; the `sale`
 * rows (net cash kept per sale) and `no_sale` rows (drawer opened without a sale,
 * amount 0) are the drawer's audit trail and are NOT part of the expected cash.
 */
export enum CashMovementType {
  OPENING_FLOAT = 'opening_float',
  PAID_IN = 'paid_in',
  PAID_OUT = 'paid_out',
  SAFE_DROP = 'safe_drop',
  EXPENSE = 'expense',
  // Extension point for returns: cash handed back to a customer
  REFUND = 'refund',
  // Net cash a sale left in the drawer (trace only, see ledgerOnly)
  SALE = 'sale',
  // Drawer opened without a sale (amount 0, reason required)
  NO_SALE = 'no_sale',
}

/** Ledger rows that never enter the expected-cash formula */
export const LEDGER_ONLY_TYPES: readonly CashMovementType[] = [
  CashMovementType.SALE,
  CashMovementType.NO_SALE,
];

export const CASH_IN_TYPES: readonly CashMovementType[] = [
  CashMovementType.OPENING_FLOAT,
  CashMovementType.PAID_IN,
];

@Entity('cash_movements')
@Index('IDX_cash_movements_shift', ['tenantId', 'shiftId'])
// A paid expense has exactly one drawer movement
@Index('uq_cash_movement_expense', ['expenseId'], {
  unique: true,
  where: '"expenseId" IS NOT NULL',
})
// Retried requests (and other modules, e.g. returns) never post twice
@Index('uq_cash_movement_idempotency', ['tenantId', 'idempotencyKey'], {
  unique: true,
  where: '"idempotencyKey" IS NOT NULL',
})
@Index('uq_cash_movement_source', ['tenantId', 'sourceType', 'sourceId'], {
  unique: true,
  where: '"sourceId" IS NOT NULL',
})
export class CashMovement extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  shiftId: string;

  @Column({ type: 'uuid', nullable: false })
  registerId: string;

  @Column({
    type: 'enum',
    enum: CashMovementType,
    enumName: 'cash_movements_type_enum',
    nullable: false,
  })
  type: CashMovementType;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  amount: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reference: string | null;

  @Column({ type: 'uuid', nullable: true })
  expenseId: string | null;

  // Generic link for other modules (e.g. sourceType 'return' + the return id)
  @Column({ type: 'varchar', length: 50, nullable: true })
  sourceType: string | null;

  @Column({ type: 'uuid', nullable: true })
  sourceId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  idempotencyKey: string | null;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @Column({ type: 'uuid', nullable: true })
  approverId: string | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_cash_movements_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => Shift, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'shiftId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_cash_movements_shift',
    },
    {
      name: 'tenantId',
      referencedColumnName: 'tenantId',
      foreignKeyConstraintName: 'FK_cash_movements_shift',
    },
  ])
  shift: Shift;

  @ManyToOne(() => Expense, { onDelete: 'NO ACTION', nullable: true })
  @JoinColumn({
    name: 'expenseId',
    foreignKeyConstraintName: 'FK_cash_movements_expense',
  })
  expense: Expense | null;

  @ManyToOne(() => User, { onDelete: 'NO ACTION' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'FK_cash_movements_user',
  })
  user: User;
}
