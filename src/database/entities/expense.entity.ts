import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseEntityWithVersion } from './base.entity';
import { Tenant } from './tenant.entity';
import { ExpenseCategory } from './expense-category.entity';
import { User } from './user.entity';

// draft → submitted → approved | rejected → paid (rejected can be edited back to draft)
export enum ExpenseStatus {
  DRAFT = 'draft',
  SUBMITTED = 'submitted',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  PAID = 'paid',
}

export enum ExpensePaymentMethod {
  CASH = 'cash',
  CARD = 'card',
  BANK = 'bank',
  OTHER = 'other',
}

@Entity('expenses')
@Unique('uq_expense_number', ['tenantId', 'expenseNumber'])
@Unique('uq_expense_id_tenant', ['id', 'tenantId'])
@Index('IDX_expenses_tenant_date', ['tenantId', 'expenseDate'])
@Index('IDX_expenses_tenant_status', ['tenantId', 'status'])
@Index('IDX_expenses_shift', ['shiftId'])
export class Expense extends BaseEntityWithVersion {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  expenseNumber: string;

  @Column({ type: 'date', nullable: false })
  expenseDate: string;

  @Column({ type: 'uuid', nullable: true })
  categoryId: string | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  amount: number;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  @Column({ type: 'varchar', length: 500, nullable: false })
  description: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  payee: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  receiptReference: string | null;

  @Column({
    type: 'enum',
    enum: ExpensePaymentMethod,
    enumName: 'expenses_paymentmethod_enum',
    default: ExpensePaymentMethod.CASH,
    nullable: false,
  })
  paymentMethod: ExpensePaymentMethod;

  // Set when paid from a till (cash)
  @Column({ type: 'uuid', nullable: true })
  registerId: string | null;

  @Column({ type: 'uuid', nullable: true })
  shiftId: string | null;

  @Column({
    type: 'enum',
    enum: ExpenseStatus,
    enumName: 'expenses_status_enum',
    default: ExpenseStatus.DRAFT,
    nullable: false,
  })
  status: ExpenseStatus;

  @Column({ type: 'boolean', default: false, nullable: false })
  approvalRequired: boolean;

  @Column({ type: 'uuid', nullable: false })
  createdById: string;

  @Column({ type: 'timestamptz', nullable: true })
  submittedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  submittedById: string | null;

  @Column({ type: 'uuid', nullable: true })
  approvedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  approvedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  rejectedById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  rejectedAt: Date | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  rejectionReason: string | null;

  @Column({ type: 'uuid', nullable: true })
  paidById: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  paidAt: Date | null;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  notes: string | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_expenses_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => ExpenseCategory, { onDelete: 'NO ACTION', nullable: true })
  @JoinColumn([
    {
      name: 'categoryId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_expenses_category',
    },
    {
      name: 'tenantId',
      referencedColumnName: 'tenantId',
      foreignKeyConstraintName: 'FK_expenses_category',
    },
  ])
  category: ExpenseCategory | null;

  @ManyToOne(() => User, { onDelete: 'NO ACTION' })
  @JoinColumn({
    name: 'createdById',
    foreignKeyConstraintName: 'FK_expenses_created_by',
  })
  createdBy: User;
}
