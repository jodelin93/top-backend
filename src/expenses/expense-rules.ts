import { ExpenseStatus } from '../database/entities/expense.entity';

/**
 * Pure expense workflow rules (unit tested).
 * draft → submitted → approved | rejected → paid; rejected can be edited (back to draft).
 */
export type ExpenseAction =
  'edit' | 'delete' | 'submit' | 'approve' | 'reject' | 'pay';

const ALLOWED: Record<ExpenseAction, ExpenseStatus[]> = {
  edit: [ExpenseStatus.DRAFT, ExpenseStatus.REJECTED],
  delete: [ExpenseStatus.DRAFT, ExpenseStatus.REJECTED],
  submit: [ExpenseStatus.DRAFT],
  approve: [ExpenseStatus.SUBMITTED],
  reject: [ExpenseStatus.SUBMITTED, ExpenseStatus.APPROVED],
  pay: [ExpenseStatus.APPROVED],
};

export function canTransition(
  status: ExpenseStatus,
  action: ExpenseAction,
): boolean {
  return ALLOWED[action].includes(status);
}

/** Amounts strictly above the store threshold need an approver */
export function needsApproval(amount: number, threshold: number): boolean {
  const t = Math.max(0, Number(threshold) || 0);
  return Math.round(amount * 100) > Math.round(t * 100);
}

/** The approver must be someone other than whoever recorded or submitted it */
export function isValidApprover(
  approverId: string,
  expense: { createdById: string; submittedById: string | null },
): boolean {
  return (
    approverId !== expense.createdById && approverId !== expense.submittedById
  );
}
