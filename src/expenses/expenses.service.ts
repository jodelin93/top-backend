import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  branchScope,
  canAccessBranch,
  registerBranchId,
  scopedBranchIds,
} from '../auth/branch-scope';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  Expense,
  ExpensePaymentMethod,
  ExpenseStatus,
} from '../database/entities/expense.entity';
import { ExpenseCategory } from '../database/entities/expense-category.entity';
import { CashMovementType } from '../database/entities/cash-movement.entity';
import { Register } from '../database/entities/register.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { ShiftsService } from '../shifts/shifts.service';
import { TenantCrudService } from '../common/crud/tenant-crud.service';
import { OutboxService } from '../platform/outbox/outbox.service';
import { requestContext } from '../common/context/request-context';
import { paginate } from '../common/dto/pagination.dto';
import { nextDocumentNumber } from '../common/utils/sequence';
import { round2 } from '../sales/sale-calculator';
import {
  canTransition,
  ExpenseAction,
  isValidApprover,
  needsApproval,
} from './expense-rules';
import {
  CreateExpenseDto,
  ListExpensesQueryDto,
  PayExpenseDto,
  UpdateExpenseDto,
} from './expenses.dto';
import { containsPattern } from '../common/utils/like';
import { ApprovalsService } from '../approvals/approvals.service';
import {
  assertNotFutureDay,
  storeTimezone,
  todayIn,
} from '../common/validation/date-rules';

const can = (user: AuthUser, permission: string) =>
  user.permissions?.some((p) => p === permission) ?? false;

@Injectable()
export class ExpenseCategoriesService extends TenantCrudService<ExpenseCategory> {
  protected readonly entityName = 'Expense category';
  protected readonly defaultOrder = { name: 'ASC' as const };
  constructor(
    @InjectRepository(ExpenseCategory) repository: Repository<ExpenseCategory>,
  ) {
    super(repository);
  }
}

// The register of an expense: its own, else its shift's
const EXPENSE_REGISTER_SQL = `COALESCE("expense"."registerId", (SELECT es."registerId" FROM shifts es WHERE es.id = "expense"."shiftId"))`;

@Injectable()
export class ExpensesService {
  constructor(
    @InjectRepository(Expense) private expenseRepository: Repository<Expense>,
    private dataSource: DataSource,
    private auditService: AuditService,
    private settingsService: SettingsService,
    private shiftsService: ShiftsService,
    // Domain events (expense.paid); optional for unit tests
    @Optional() private outbox?: OutboxService,
    // Verifies a second person's approval token (separation of duties)
    @Optional() private approvalsService?: ApprovalsService,
  ) {}

  async list(tenantId: string, user: AuthUser, query: ListExpensesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const qb = this.expenseRepository
      .createQueryBuilder('expense')
      .leftJoin('expense.category', 'category')
      .leftJoin('expense.createdBy', 'createdBy')
      .addSelect([
        'category.id',
        'category.name',
        'category.code',
        'createdBy.id',
        'createdBy.email',
        'createdBy.firstName',
        'createdBy.lastName',
      ])
      .where('expense.tenantId = :tenantId', { tenantId })
      .orderBy('expense.expenseDate', 'DESC')
      .addOrderBy('expense.createdAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    // Without expenses.approve you only see what you recorded
    if (!can(user, 'expenses.approve')) {
      qb.andWhere('expense.createdById = :me', { me: user.id });
    }
    if (query.status) {
      qb.andWhere('expense.status = :status', { status: query.status });
    }
    if (query.categoryId) {
      qb.andWhere('expense.categoryId = :categoryId', {
        categoryId: query.categoryId,
      });
    }
    if (query.registerId) {
      qb.andWhere('expense.registerId = :registerId', {
        registerId: query.registerId,
      });
    }
    if (query.shiftId) {
      qb.andWhere('expense.shiftId = :shiftId', { shiftId: query.shiftId });
    }
    // Branch-limited users: expenses of their branches' registers, and the
    // store-level ones (no register) they recorded themselves (spec §9)
    const branches = scopedBranchIds(branchScope(user));
    if (branches) {
      qb.andWhere(
        `(CASE WHEN ${EXPENSE_REGISTER_SQL} IS NULL THEN "expense"."createdById" = :me
               ELSE ${EXPENSE_REGISTER_SQL} IN (SELECT rs.id FROM registers rs WHERE rs."branchId" = ANY(:expenseBranches)) END)`,
        { me: user.id, expenseBranches: branches },
      );
    }
    if (query.paymentMethod) {
      qb.andWhere('expense.paymentMethod = :pm', { pm: query.paymentMethod });
    }
    if (query.from) {
      qb.andWhere('expense.expenseDate >= :from', {
        from: query.from.slice(0, 10),
      });
    }
    if (query.to) {
      qb.andWhere('expense.expenseDate <= :to', { to: query.to.slice(0, 10) });
    }
    if (query.search?.trim()) {
      qb.andWhere(
        '(expense.description ILIKE :q OR expense.payee ILIKE :q OR expense.expenseNumber ILIKE :q OR expense.receiptReference ILIKE :q)',
        { q: containsPattern(query.search) },
      );
    }

    const [rows, total] = await qb.getManyAndCount();
    const names = await this.userNames(
      rows.flatMap((r) => [r.approvedById, r.rejectedById, r.paidById]),
    );
    return paginate(
      rows.map((row) => this.view(row, names)),
      total,
      page,
      limit,
    );
  }

  async findOne(tenantId: string, user: AuthUser, id: string) {
    const expense = await this.expenseRepository.findOne({
      where: { id, tenantId },
      relations: { category: true, createdBy: true },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    await this.assertExpenseBranch(this.dataSource.manager, expense, user);
    if (!can(user, 'expenses.approve') && expense.createdById !== user.id) {
      throw new ForbiddenException('You can only view your own expenses');
    }
    const names = await this.userNames([
      expense.approvedById,
      expense.rejectedById,
      expense.paidById,
    ]);
    const [movement] = await this.dataSource.query<
      { id: string; shiftId: string; amount: number }[]
    >(
      `SELECT id, "shiftId", amount FROM cash_movements WHERE "tenantId" = $1 AND "expenseId" = $2`,
      [tenantId, id],
    );
    return { ...this.view(expense, names), cashMovement: movement ?? null };
  }

  async create(tenantId: string, user: AuthUser, dto: CreateExpenseDto) {
    await this.assertCategory(tenantId, dto.categoryId);
    await this.assertRegister(tenantId, dto.registerId);
    const { currencyCode } = await this.settingsService.getSettings(tenantId);

    const id = await this.dataSource.transaction(async (manager) => {
      const expenseNumber = await nextDocumentNumber(manager, {
        table: 'expenses',
        column: 'expenseNumber',
        tenantId,
        prefix: 'EXP',
      });
      const timezone = await this.expenseTimezone(
        manager,
        tenantId,
        dto.registerId,
      );
      const expenseDate = (dto.expenseDate ?? todayIn(timezone)).slice(0, 10);
      assertNotFutureDay(
        expenseDate,
        timezone,
        'The expense date cannot be in the future',
      );
      const repo = manager.getRepository(Expense);
      const expense = await repo.save(
        repo.create({
          tenantId,
          expenseNumber,
          expenseDate,
          categoryId: dto.categoryId ?? null,
          amount: round2(dto.amount),
          currencyCode,
          description: dto.description.trim(),
          payee: dto.payee?.trim() || null,
          receiptReference: dto.receiptReference?.trim() || null,
          paymentMethod: dto.paymentMethod ?? ExpensePaymentMethod.CASH,
          registerId: dto.registerId ?? null,
          notes: dto.notes?.trim() || null,
          status: ExpenseStatus.DRAFT,
          createdById: user.id,
        }),
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'expense.created',
          entityType: 'expense',
          entityId: expense.id,
          changes: { after: expense },
        },
        manager,
      );
      if (dto.submit) {
        await this.applySubmit(manager, tenantId, user, expense);
      }
      return expense.id;
    });
    return this.findOne(tenantId, user, id);
  }

  async update(
    tenantId: string,
    user: AuthUser,
    id: string,
    dto: UpdateExpenseDto,
  ) {
    if (dto.categoryId) await this.assertCategory(tenantId, dto.categoryId);
    if (dto.registerId) await this.assertRegister(tenantId, dto.registerId);
    await this.dataSource.transaction(async (manager) => {
      const expense = await this.lock(manager, tenantId, id);
      this.assertOwnerOrApprover(user, expense);
      this.assertTransition(expense, 'edit');
      const before = { ...expense };
      const { amount, description, payee, receiptReference, notes, ...rest } =
        dto;
      Object.assign(
        expense,
        Object.fromEntries(
          Object.entries(rest).filter(([, value]) => value !== undefined),
        ),
      );
      if (amount !== undefined) expense.amount = round2(amount);
      if (description !== undefined) expense.description = description.trim();
      if (payee !== undefined) expense.payee = payee?.trim() || null;
      if (receiptReference !== undefined) {
        expense.receiptReference = receiptReference?.trim() || null;
      }
      if (notes !== undefined) expense.notes = notes?.trim() || null;
      if (dto.expenseDate) {
        assertNotFutureDay(
          dto.expenseDate.slice(0, 10),
          await this.expenseTimezone(manager, tenantId, expense.registerId),
          'The expense date cannot be in the future',
        );
        expense.expenseDate = dto.expenseDate.slice(0, 10);
      }
      // Editing a rejected expense puts it back into draft
      if (expense.status === ExpenseStatus.REJECTED) {
        expense.status = ExpenseStatus.DRAFT;
      }
      await manager.getRepository(Expense).save(expense);
      await this.auditService.record(
        {
          tenantId,
          action: 'expense.updated',
          entityType: 'expense',
          entityId: id,
          changes: { before, after: expense },
        },
        manager,
      );
    });
    return this.findOne(tenantId, user, id);
  }

  async remove(tenantId: string, user: AuthUser, id: string) {
    await this.dataSource.transaction(async (manager) => {
      const expense = await this.lock(manager, tenantId, id);
      this.assertOwnerOrApprover(user, expense);
      this.assertTransition(expense, 'delete');
      await manager.getRepository(Expense).delete({ id, tenantId });
      await this.auditService.record(
        {
          tenantId,
          action: 'expense.deleted',
          entityType: 'expense',
          entityId: id,
          changes: { before: expense },
        },
        manager,
      );
    });
  }

  async submit(tenantId: string, user: AuthUser, id: string) {
    await this.dataSource.transaction(async (manager) => {
      const expense = await this.lock(manager, tenantId, id);
      this.assertOwnerOrApprover(user, expense);
      await this.applySubmit(manager, tenantId, user, expense);
    });
    return this.findOne(tenantId, user, id);
  }

  /**
   * Approve: by someone with expenses.approve (or a manager's approval token)
   * who is not the person who recorded or submitted it.
   *
   * When the signed-in user holds expenses.approve but recorded/submitted the
   * expense themselves, PermissionsGuard lets them through without looking at
   * the approval token; the approval must then come from someone else, via a
   * token (X-Approval-Token) issued by that person for this action. The token's
   * owner is the approver of record.
   */
  async approve(
    tenantId: string,
    user: AuthUser,
    id: string,
    approvalToken?: string,
  ) {
    let approverId = requestContext.get()?.approverId ?? user.id;
    await this.dataSource.transaction(async (manager) => {
      const expense = await this.lock(manager, tenantId, id);
      this.assertTransition(expense, 'approve');
      if (!isValidApprover(approverId, expense)) {
        approverId = await this.secondPersonApprover(
          user,
          expense,
          approvalToken,
        );
      }
      expense.status = ExpenseStatus.APPROVED;
      expense.approvedById = approverId;
      expense.approvedAt = new Date();
      expense.rejectedById = null;
      expense.rejectedAt = null;
      expense.rejectionReason = null;
      await manager.getRepository(Expense).save(expense);
      await this.auditService.record(
        {
          tenantId,
          action: 'expense.approved',
          entityType: 'expense',
          entityId: id,
          approverId: approverId === user.id ? undefined : approverId,
          metadata: { amount: expense.amount },
        },
        manager,
      );
    });
    return this.findOne(tenantId, user, id);
  }

  async reject(tenantId: string, user: AuthUser, id: string, reason: string) {
    const approverId = requestContext.get()?.approverId ?? user.id;
    await this.dataSource.transaction(async (manager) => {
      const expense = await this.lock(manager, tenantId, id);
      this.assertTransition(expense, 'reject');
      expense.status = ExpenseStatus.REJECTED;
      expense.rejectedById = approverId;
      expense.rejectedAt = new Date();
      expense.rejectionReason = reason.trim();
      expense.approvedById = null;
      expense.approvedAt = null;
      await manager.getRepository(Expense).save(expense);
      await this.auditService.record(
        {
          tenantId,
          action: 'expense.rejected',
          entityType: 'expense',
          entityId: id,
          reason: expense.rejectionReason,
        },
        manager,
      );
    });
    return this.findOne(tenantId, user, id);
  }

  /**
   * Mark paid. Cash paid from a till posts exactly one cash movement to that
   * register's open shift (unique on expenseId). Paying twice returns the paid expense.
   */
  async pay(tenantId: string, user: AuthUser, id: string, dto: PayExpenseDto) {
    if (dto.registerId) await this.assertRegister(tenantId, dto.registerId);
    let replayed = false;
    await this.dataSource.transaction(async (manager) => {
      const expense = await this.lock(manager, tenantId, id);
      if (expense.status === ExpenseStatus.PAID) {
        replayed = true;
        return;
      }
      this.assertTransition(expense, 'pay');

      const registerId = dto.registerId ?? expense.registerId;
      if (expense.paymentMethod === ExpensePaymentMethod.CASH && registerId) {
        const shift = await this.shiftsService.getOpenShift(
          tenantId,
          registerId,
          manager,
        );
        if (!shift) {
          throw new ConflictException(
            'This register has no open shift to pay the expense from',
          );
        }
        await this.shiftsService.recordCashMovement(manager, {
          tenantId,
          shiftId: shift.id,
          type: CashMovementType.EXPENSE,
          amount: expense.amount,
          userId: user.id,
          approverId: expense.approvedById,
          reason: `${expense.expenseNumber}: ${expense.description}`.slice(
            0,
            500,
          ),
          reference: dto.reference?.trim() || expense.receiptReference,
          expenseId: expense.id,
        });
        expense.registerId = registerId;
        expense.shiftId = shift.id;
      }

      expense.status = ExpenseStatus.PAID;
      expense.paidById = user.id;
      expense.paidAt = new Date();
      await manager.getRepository(Expense).save(expense);
      await this.auditService.record(
        {
          tenantId,
          action: 'expense.paid',
          entityType: 'expense',
          entityId: id,
          metadata: {
            amount: expense.amount,
            paymentMethod: expense.paymentMethod,
            registerId: expense.registerId,
            shiftId: expense.shiftId,
          },
        },
        manager,
      );
      await this.outbox?.record(manager, {
        tenantId,
        type: 'expense.paid',
        aggregateId: expense.id,
        aggregateVersion: expense.version ?? null,
        payload: {
          expenseId: expense.id,
          expenseNumber: expense.expenseNumber,
          amount: round2(Number(expense.amount)),
          currencyCode: expense.currencyCode,
          paymentMethod: expense.paymentMethod,
          registerId: expense.registerId ?? null,
          shiftId: expense.shiftId ?? null,
        },
      });
    });
    const result = await this.findOne(tenantId, user, id);
    return { ...result, replayed };
  }

  // ---------------------------------------------------------------------------

  private async applySubmit(
    manager: EntityManager,
    tenantId: string,
    user: AuthUser,
    expense: Expense,
  ) {
    this.assertTransition(expense, 'submit');
    const { expenseApprovalThreshold } =
      await this.settingsService.getSettings(tenantId);
    const required = needsApproval(
      Number(expense.amount),
      expenseApprovalThreshold,
    );
    const now = new Date();
    expense.submittedAt = now;
    expense.submittedById = user.id;
    expense.approvalRequired = required;
    // At or below the threshold no approver is needed
    expense.status = required
      ? ExpenseStatus.SUBMITTED
      : ExpenseStatus.APPROVED;
    if (!required) expense.approvedAt = now;
    await manager.getRepository(Expense).save(expense);
    await this.auditService.record(
      {
        tenantId,
        action: required ? 'expense.submitted' : 'expense.auto_approved',
        entityType: 'expense',
        entityId: expense.id,
        metadata: {
          amount: expense.amount,
          threshold: expenseApprovalThreshold,
        },
      },
      manager,
    );
  }

  /**
   * The approver of an expense the user may not approve alone (they recorded
   * or submitted it): the owner of a valid approval token for expenses.approve
   * that is neither the creator nor the submitter. Otherwise a 403 the
   * frontend's useApproval() turns into a "second person" prompt
   * (ApprovalUsesInterceptor adds the `action` the token must be issued for).
   */
  private async secondPersonApprover(
    user: AuthUser,
    expense: Expense,
    approvalToken?: string,
  ): Promise<string> {
    const tokens = (approvalToken ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 5);
    for (const token of tokens) {
      const tokenApprover = await this.approvalsService?.verify(
        token,
        'expenses.approve',
        user,
      );
      if (tokenApprover && isValidApprover(tokenApprover, expense)) {
        requestContext.set({ approverId: tokenApprover });
        return tokenApprover;
      }
    }
    throw new ForbiddenException({
      message: 'An expense must be approved by a different person',
      error: 'Forbidden',
      missingPermissions: ['expenses.approve'],
      approvable: true,
    });
  }

  private async lock(manager: EntityManager, tenantId: string, id: string) {
    const expense = await manager.getRepository(Expense).findOne({
      where: { id, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    await this.assertExpenseBranch(manager, expense);
    return expense;
  }

  /**
   * Another branch's expense is "not found" for a branch-limited user; one with
   * no register (store level) only for the person who recorded it
   */
  private async assertExpenseBranch(
    manager: EntityManager,
    expense: Expense,
    user?: AuthUser,
  ) {
    const scope = branchScope(user);
    if (scope === null) return;
    let registerId = expense.registerId;
    if (!registerId && expense.shiftId) {
      const [shift] = await manager.query<{ registerId: string }[]>(
        `SELECT "registerId" FROM shifts WHERE id = $1 AND "tenantId" = $2`,
        [expense.shiftId, expense.tenantId],
      );
      registerId = shift?.registerId ?? null;
    }
    if (!registerId) {
      const me = user?.id ?? requestContext.get()?.userId;
      if (expense.createdById !== me) {
        throw new NotFoundException('Expense not found');
      }
      return;
    }
    const branchId = await registerBranchId(
      manager,
      expense.tenantId,
      registerId,
    );
    if (!canAccessBranch(branchId, scope)) {
      throw new NotFoundException('Expense not found');
    }
  }

  private assertTransition(expense: Expense, action: ExpenseAction) {
    if (!canTransition(expense.status, action)) {
      throw new ConflictException(
        `Cannot ${action} an expense that is ${expense.status}`,
      );
    }
  }

  private assertOwnerOrApprover(user: AuthUser, expense: Expense) {
    if (expense.createdById === user.id || can(user, 'expenses.approve')) {
      return;
    }
    throw new ForbiddenException('You can only change your own expenses');
  }

  private async assertCategory(tenantId: string, categoryId?: string | null) {
    if (!categoryId) return;
    const category = await this.dataSource
      .getRepository(ExpenseCategory)
      .findOne({ where: { id: categoryId, tenantId } });
    if (!category) throw new BadRequestException('Expense category not found');
    if (!category.isActive) {
      throw new BadRequestException('This expense category is inactive');
    }
  }

  /** Time zone of the expense's branch (its register's), else the store's */
  private async expenseTimezone(
    manager: EntityManager,
    tenantId: string,
    registerId?: string | null,
  ): Promise<string> {
    const register = registerId
      ? await manager.getRepository(Register).findOne({
          where: { id: registerId, tenantId },
          select: { id: true, branchId: true },
        })
      : null;
    return storeTimezone(manager, tenantId, register?.branchId);
  }

  private async assertRegister(tenantId: string, registerId?: string | null) {
    if (!registerId) return;
    const register = await this.dataSource.getRepository(Register).findOne({
      where: { id: registerId, tenantId },
      select: { id: true, branchId: true },
    });
    // Another branch's till is not one this user can pay from (spec §9)
    if (!register || !canAccessBranch(register.branchId)) {
      throw new BadRequestException('Register not found');
    }
  }

  private async userNames(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter(Boolean))] as string[];
    const rows = unique.length
      ? await this.dataSource.query<
          {
            id: string;
            email: string;
            firstName: string | null;
            lastName: string | null;
          }[]
        >(
          `SELECT id, email, "firstName", "lastName" FROM users WHERE id = ANY($1)`,
          [unique],
        )
      : [];
    return new Map(rows.map((u) => [u.id, displayName(u)]));
  }

  private view(expense: Expense, names: Map<string, string>) {
    const name = (id: string | null) => (id ? (names.get(id) ?? null) : null);
    return {
      id: expense.id,
      expenseNumber: expense.expenseNumber,
      expenseDate: expense.expenseDate,
      categoryId: expense.categoryId,
      categoryName: expense.category?.name ?? null,
      amount: round2(Number(expense.amount)),
      currencyCode: expense.currencyCode,
      description: expense.description,
      payee: expense.payee,
      receiptReference: expense.receiptReference,
      paymentMethod: expense.paymentMethod,
      registerId: expense.registerId,
      shiftId: expense.shiftId,
      status: expense.status,
      approvalRequired: expense.approvalRequired,
      notes: expense.notes,
      createdById: expense.createdById,
      createdByName: expense.createdBy ? displayName(expense.createdBy) : null,
      createdAt: expense.createdAt,
      submittedAt: expense.submittedAt,
      approvedById: expense.approvedById,
      approvedByName: name(expense.approvedById),
      approvedAt: expense.approvedAt,
      rejectedById: expense.rejectedById,
      rejectedByName: name(expense.rejectedById),
      rejectedAt: expense.rejectedAt,
      rejectionReason: expense.rejectionReason,
      paidById: expense.paidById,
      paidByName: name(expense.paidById),
      paidAt: expense.paidAt,
    };
  }
}

function displayName(user: {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}) {
  return (
    [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email
  );
}
