import { ConflictException, ForbiddenException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  Expense,
  ExpensePaymentMethod,
  ExpenseStatus,
} from '../database/entities/expense.entity';
import { CashMovementType } from '../database/entities/cash-movement.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import type { AuditService } from '../audit/audit.service';
import type { SettingsService } from '../settings/settings.service';
import type { ShiftsService } from '../shifts/shifts.service';
import type { ApprovalsService } from '../approvals/approvals.service';
import { requestContext } from '../common/context/request-context';
import { ExpensesService } from './expenses.service';

const TENANT = 'tenant-1';
const cashier = {
  id: 'cashier-1',
  permissions: ['expenses.create'],
} as unknown as AuthUser;
const manager = {
  id: 'manager-1',
  permissions: ['expenses.create', 'expenses.approve'],
} as unknown as AuthUser;

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return Object.assign(new Expense(), {
    id: 'exp-1',
    tenantId: TENANT,
    expenseNumber: 'EXP-000001',
    expenseDate: '2026-09-24',
    amount: 80,
    description: 'Window repair',
    paymentMethod: ExpensePaymentMethod.CASH,
    registerId: 'reg-1',
    shiftId: null,
    status: ExpenseStatus.APPROVED,
    createdById: cashier.id,
    submittedById: cashier.id,
    approvedById: manager.id,
    receiptReference: null,
    ...overrides,
  });
}

const owner = {
  id: 'owner-1',
  tenantId: TENANT,
  permissions: ['expenses.create', 'expenses.approve'],
} as unknown as AuthUser;

function setup(
  expense: Expense,
  threshold = 50,
  // Approval tokens: token -> approver id (verify() answers null otherwise)
  tokens: Record<string, string> = {},
) {
  const saved: Expense[] = [];
  const repo = {
    findOne: jest.fn(() => Promise.resolve(expense)),
    save: jest.fn((e: Expense) => {
      saved.push({ ...e });
      return Promise.resolve(e);
    }),
  };
  const manager = {
    getRepository: jest.fn(() => repo),
  } as unknown as EntityManager;
  const dataSource = {
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager),
    ),
    query: jest.fn(() => Promise.resolve([])),
    getRepository: jest.fn(() => ({
      exists: jest.fn(() => Promise.resolve(true)),
    })),
  } as unknown as DataSource;
  const shifts = {
    getOpenShift: jest.fn(() => Promise.resolve({ id: 'shift-1' })),
    recordCashMovement: jest.fn(() => Promise.resolve({ id: 'mv-1' })),
  };
  const settings = {
    getSettings: jest.fn(() =>
      Promise.resolve({ expenseApprovalThreshold: threshold }),
    ),
  };
  const approvals = {
    verify: jest.fn((token: string) => Promise.resolve(tokens[token] ?? null)),
  };
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const service = new ExpensesService(
    repo as unknown as Repository<Expense>,
    dataSource,
    audit as unknown as AuditService,
    settings as unknown as SettingsService,
    shifts as unknown as ShiftsService,
    undefined,
    approvals as unknown as ApprovalsService,
  );
  return { service, saved, shifts, approvals, audit };
}

describe('ExpensesService.pay', () => {
  it('posts exactly one cash movement to the register’s open shift', async () => {
    const expense = makeExpense();
    const { service, saved, shifts } = setup(expense);
    const result = await service.pay(TENANT, cashier, expense.id, {});
    expect(shifts.recordCashMovement).toHaveBeenCalledTimes(1);
    expect(shifts.recordCashMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        type: CashMovementType.EXPENSE,
        amount: 80,
        expenseId: expense.id,
        shiftId: 'shift-1',
      }),
    );
    expect(saved[0]).toMatchObject({
      status: ExpenseStatus.PAID,
      shiftId: 'shift-1',
    });
    expect(result.replayed).toBe(false);
  });

  it('paying a paid expense again changes nothing', async () => {
    const expense = makeExpense({ status: ExpenseStatus.PAID });
    const { service, saved, shifts } = setup(expense);
    const result = await service.pay(TENANT, cashier, expense.id, {});
    expect(result.replayed).toBe(true);
    expect(shifts.recordCashMovement).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
  });

  it('needs an open shift for cash from a till', async () => {
    const expense = makeExpense();
    const { service, shifts } = setup(expense);
    shifts.getOpenShift.mockResolvedValueOnce(null as never);
    await expect(
      service.pay(TENANT, cashier, expense.id, {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('does not touch a drawer for card expenses', async () => {
    const expense = makeExpense({ paymentMethod: ExpensePaymentMethod.CARD });
    const { service, shifts } = setup(expense);
    await service.pay(TENANT, cashier, expense.id, {});
    expect(shifts.recordCashMovement).not.toHaveBeenCalled();
  });

  it('cannot pay an expense that is still waiting for approval', async () => {
    const expense = makeExpense({ status: ExpenseStatus.SUBMITTED });
    const { service } = setup(expense);
    await expect(
      service.pay(TENANT, cashier, expense.id, {}),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('ExpensesService approval', () => {
  it('auto-approves at or below the threshold on submit', async () => {
    const expense = makeExpense({ status: ExpenseStatus.DRAFT, amount: 50 });
    const { service, saved } = setup(expense, 50);
    await service.submit(TENANT, cashier, expense.id);
    expect(saved[0]).toMatchObject({
      status: ExpenseStatus.APPROVED,
      approvalRequired: false,
    });
  });

  it('needs an approver above the threshold', async () => {
    const expense = makeExpense({ status: ExpenseStatus.DRAFT, amount: 80 });
    const { service, saved } = setup(expense, 50);
    await service.submit(TENANT, cashier, expense.id);
    expect(saved[0]).toMatchObject({
      status: ExpenseStatus.SUBMITTED,
      approvalRequired: true,
    });
  });

  it('refuses approval by the person who submitted it', async () => {
    const expense = makeExpense({
      status: ExpenseStatus.SUBMITTED,
      createdById: manager.id,
      submittedById: manager.id,
    });
    const { service } = setup(expense);
    await expect(
      requestContext.run({}, () => service.approve(TENANT, manager, 'exp-1')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('records the manager-override approver', async () => {
    const expense = makeExpense({ status: ExpenseStatus.SUBMITTED });
    const { service, saved } = setup(expense);
    await requestContext.run({ approverId: manager.id }, () =>
      service.approve(TENANT, cashier, 'exp-1'),
    );
    expect(saved[0]).toMatchObject({
      status: ExpenseStatus.APPROVED,
      approvedById: manager.id,
    });
  });

  describe('creator who also holds expenses.approve', () => {
    const ownExpense = () =>
      makeExpense({
        status: ExpenseStatus.SUBMITTED,
        createdById: owner.id,
        submittedById: owner.id,
        approvedById: null,
      });

    it("is approved through another person's approval token", async () => {
      const expense = ownExpense();
      const { service, saved, approvals, audit } = setup(expense, 50, {
        'marc-token': manager.id,
      });
      await requestContext.run({}, () =>
        service.approve(TENANT, owner, 'exp-1', 'marc-token'),
      );
      expect(approvals.verify).toHaveBeenCalledWith(
        'marc-token',
        'expenses.approve',
        owner,
      );
      expect(saved[0]).toMatchObject({
        status: ExpenseStatus.APPROVED,
        approvedById: manager.id,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'expense.approved',
          approverId: manager.id,
        }),
        expect.anything(),
      );
    });

    it('is refused without a token, asking for an approval', async () => {
      const { service, saved } = setup(ownExpense());
      const error = await requestContext
        .run({}, () => service.approve(TENANT, owner, 'exp-1'))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        missingPermissions: ['expenses.approve'],
        approvable: true,
      });
      expect(saved).toHaveLength(0);
    });

    it('is refused when the token is invalid', async () => {
      const { service, saved } = setup(ownExpense());
      await expect(
        requestContext.run({}, () =>
          service.approve(TENANT, owner, 'exp-1', 'forged'),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(saved).toHaveLength(0);
    });

    it('is refused when the token comes from the submitter', async () => {
      // e.g. created by the owner, submitted by marc: marc cannot approve it
      const expense = makeExpense({
        status: ExpenseStatus.SUBMITTED,
        createdById: owner.id,
        submittedById: manager.id,
        approvedById: null,
      });
      const { service, saved } = setup(expense, 50, {
        'marc-token': manager.id,
      });
      await expect(
        requestContext.run({}, () =>
          service.approve(TENANT, owner, 'exp-1', 'marc-token'),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(saved).toHaveLength(0);
    });
  });
});
