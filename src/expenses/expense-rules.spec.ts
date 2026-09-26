import { ExpenseStatus } from '../database/entities/expense.entity';
import { canTransition, isValidApprover, needsApproval } from './expense-rules';

describe('expense rules', () => {
  it('follows draft → submitted → approved/rejected → paid', () => {
    expect(canTransition(ExpenseStatus.DRAFT, 'submit')).toBe(true);
    expect(canTransition(ExpenseStatus.SUBMITTED, 'approve')).toBe(true);
    expect(canTransition(ExpenseStatus.SUBMITTED, 'reject')).toBe(true);
    expect(canTransition(ExpenseStatus.APPROVED, 'pay')).toBe(true);
    expect(canTransition(ExpenseStatus.REJECTED, 'edit')).toBe(true);
  });

  it('forbids skipping steps or changing paid expenses', () => {
    expect(canTransition(ExpenseStatus.DRAFT, 'pay')).toBe(false);
    expect(canTransition(ExpenseStatus.SUBMITTED, 'pay')).toBe(false);
    expect(canTransition(ExpenseStatus.PAID, 'pay')).toBe(false);
    expect(canTransition(ExpenseStatus.PAID, 'edit')).toBe(false);
    expect(canTransition(ExpenseStatus.PAID, 'reject')).toBe(false);
    expect(canTransition(ExpenseStatus.APPROVED, 'approve')).toBe(false);
  });

  it('needs approval only strictly above the threshold', () => {
    expect(needsApproval(50, 50)).toBe(false);
    expect(needsApproval(50.01, 50)).toBe(true);
    // Threshold 0: every expense needs an approver
    expect(needsApproval(0.01, 0)).toBe(true);
  });

  it('requires a different approver than the creator or submitter', () => {
    const expense = { createdById: 'a', submittedById: 'b' };
    expect(isValidApprover('a', expense)).toBe(false);
    expect(isValidApprover('b', expense)).toBe(false);
    expect(isValidApprover('c', expense)).toBe(true);
  });
});
