import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { Employee, EmployeeStatus } from '../database/entities/employee.entity';
import { EmployeeBranch } from '../database/entities/employee-branch.entity';
import {
  AttendanceSource,
  EmployeeAttendance,
} from '../database/entities/employee-attendance.entity';
import { Branch } from '../database/entities/branch.entity';
import {
  MembershipStatus,
  TenantMembership,
} from '../database/entities/tenant-membership.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import {
  BRANCH_SCOPE_PARAM,
  type BranchScope,
  branchFilterSql,
  branchScope,
  canAccessBranch,
} from '../auth/branch-scope';
import { AuditService } from '../audit/audit.service';
import { UsersService } from '../users/users.service';
import { paginate } from '../common/dto/pagination.dto';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { spanHours, totalHours } from './attendance-math';
import {
  AttendanceReportQueryDto,
  ClockDto,
  CloseAttendanceDto,
  CreateEmployeeDto,
  DeactivateEmployeeDto,
  EmployeeBranchInput,
  ListEmployeesQueryDto,
  RecordAttendanceDto,
  UpdateEmployeeDto,
} from './employees.dto';
import { containsPattern } from '../common/utils/like';
import {
  assertDateRange,
  assertShiftLength,
  storeTimezone,
  todayIn,
} from '../common/validation/date-rules';

const can = (user: AuthUser, permission: string) =>
  user.permissions?.some((p) => p === permission) ?? false;

// Longest report window (days), so a report stays a single query
const MAX_REPORT_DAYS = 366;

const EDITABLE = [
  'firstName',
  'lastName',
  'jobTitle',
  'phone',
  'email',
  'employeeCode',
  'hireDate',
  'notes',
] as const;

/**
 * Employees (HR records) separate from logins (spec §13): branch assignments,
 * optional link to a member account, deactivation (which suspends the linked
 * login and ends its sessions) and attendance (clock in / out).
 *
 * Branch access (spec §3/§9): a user limited to some branches sees and manages
 * only the employees assigned to at least one of them (others are "not found");
 * an employee without a branch is visible to every-branch users only. Such a
 * user assigns only their own branches and leaves the others untouched.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
    private usersService: UsersService,
  ) {}

  // ---------------------------------------------------------------------------
  // Employees
  // ---------------------------------------------------------------------------

  async list(
    tenantId: string,
    query: ListEmployeesQueryDto,
    scope: BranchScope = branchScope(),
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 50;
    const qb = this.dataSource
      .getRepository(Employee)
      .createQueryBuilder('e')
      .leftJoinAndSelect('e.branches', 'b')
      .leftJoin('e.user', 'u')
      .addSelect(['u.id', 'u.email', 'u.firstName', 'u.lastName'])
      .where('e.tenantId = :tenantId', { tenantId })
      .orderBy('e.lastName', 'ASC')
      .addOrderBy('e.firstName', 'ASC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.status)
      qb.andWhere('e.status = :status', { status: query.status });
    // Limited to some branches: employees assigned to at least one of them
    if (scope !== null) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM employee_branches sb WHERE sb."employeeId" = e.id AND sb."branchId" = ANY(:${BRANCH_SCOPE_PARAM}))`,
        { [BRANCH_SCOPE_PARAM]: [...scope] },
      );
    }
    if (query.branchId) {
      qb.andWhere(
        'EXISTS (SELECT 1 FROM employee_branches eb WHERE eb."employeeId" = e.id AND eb."branchId" = :branchId)',
        { branchId: query.branchId },
      );
    }
    const search = query.search?.trim();
    if (search) {
      qb.andWhere(
        `(e.firstName ILIKE :q OR e.lastName ILIKE :q OR e.employeeCode ILIKE :q OR e.email ILIKE :q
          OR (e.firstName || ' ' || e.lastName) ILIKE :q)`,
        { q: containsPattern(search) },
      );
    }
    const [rows, total] = await qb.getManyAndCount();
    return paginate(
      rows.map((e) => this.view(e)),
      total,
      page,
      limit,
    );
  }

  async findOne(
    tenantId: string,
    id: string,
    scope: BranchScope = branchScope(),
  ) {
    return this.view(
      await this.load(this.dataSource.manager, tenantId, id, false, scope),
    );
  }

  async create(
    tenantId: string,
    dto: CreateEmployeeDto,
    scope: BranchScope = branchScope(),
  ) {
    // A branch-limited user creates employees at their own branches only
    const input = this.scopedBranchInput(dto.branches ?? [], [], scope);
    try {
      const id = await this.dataSource.transaction(async (manager) => {
        if (dto.userId)
          await this.assertLinkable(manager, tenantId, dto.userId);
        const repo = manager.getRepository(Employee);
        const employee = await repo.save(
          repo.create({
            tenantId,
            userId: dto.userId ?? null,
            firstName: dto.firstName.trim(),
            lastName: dto.lastName.trim(),
            jobTitle: clean(dto.jobTitle),
            phone: clean(dto.phone),
            email: clean(dto.email)?.toLowerCase() ?? null,
            employeeCode: clean(dto.employeeCode),
            hireDate: dto.hireDate ? dto.hireDate.slice(0, 10) : null,
            notes: clean(dto.notes),
            status: EmployeeStatus.ACTIVE,
          }),
        );
        const branches = await this.setBranches(
          manager,
          tenantId,
          employee.id,
          input,
        );
        await this.auditService.record(
          {
            tenantId,
            action: 'employee.created',
            entityType: 'employee',
            entityId: employee.id,
            changes: {
              after: {
                ...pick(employee, EDITABLE),
                userId: employee.userId,
                branches,
              },
            },
          },
          manager,
        );
        return employee.id;
      });
      return this.findOne(tenantId, id, scope);
    } catch (error) {
      throw this.uniqueError(error);
    }
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateEmployeeDto,
    scope: BranchScope = branchScope(),
  ) {
    try {
      await this.dataSource.transaction(async (manager) => {
        const employee = await this.load(manager, tenantId, id, true, scope);
        const before = {
          ...pick(employee, EDITABLE),
          branches: branchList(employee.branches),
        };
        if (dto.firstName !== undefined)
          employee.firstName = dto.firstName.trim();
        if (dto.lastName !== undefined) employee.lastName = dto.lastName.trim();
        if (dto.jobTitle !== undefined) employee.jobTitle = clean(dto.jobTitle);
        if (dto.phone !== undefined) employee.phone = clean(dto.phone);
        if (dto.email !== undefined) {
          employee.email = clean(dto.email)?.toLowerCase() ?? null;
        }
        if (dto.employeeCode !== undefined) {
          employee.employeeCode = clean(dto.employeeCode);
        }
        if (dto.hireDate !== undefined) {
          employee.hireDate = dto.hireDate ? dto.hireDate.slice(0, 10) : null;
        }
        if (dto.notes !== undefined) employee.notes = clean(dto.notes);
        const { branches: _relation, user: _user, ...columns } = employee;
        void _relation;
        void _user;
        await manager.getRepository(Employee).save(columns);
        const branches = dto.branches
          ? await this.setBranches(
              manager,
              tenantId,
              id,
              this.scopedBranchInput(dto.branches, employee.branches, scope),
            )
          : before.branches;
        await this.auditService.record(
          {
            tenantId,
            action: 'employee.updated',
            entityType: 'employee',
            entityId: id,
            changes: {
              before,
              after: { ...pick(employee, EDITABLE), branches },
            },
          },
          manager,
        );
      });
      return this.findOne(tenantId, id, scope);
    } catch (error) {
      throw this.uniqueError(error);
    }
  }

  /**
   * Replace the branches the employee works at. A branch-limited user replaces
   * only their own branches: assignments at other branches are kept.
   */
  async assignBranches(
    tenantId: string,
    id: string,
    branches: EmployeeBranchInput[],
    scope: BranchScope = branchScope(),
  ) {
    await this.dataSource.transaction(async (manager) => {
      const employee = await this.load(manager, tenantId, id, true, scope);
      const before = branchList(employee.branches);
      const after = await this.setBranches(
        manager,
        tenantId,
        id,
        this.scopedBranchInput(branches, employee.branches, scope),
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'employee.branches_assigned',
          entityType: 'employee',
          entityId: id,
          changes: { before: { branches: before }, after: { branches: after } },
        },
        manager,
      );
    });
    return this.findOne(tenantId, id, scope);
  }

  /** Link a login (member of the store) to the employee */
  async linkUser(
    tenantId: string,
    id: string,
    userId: string,
    scope: BranchScope = branchScope(),
  ) {
    try {
      await this.dataSource.transaction(async (manager) => {
        const employee = await this.load(manager, tenantId, id, true, scope);
        if (employee.userId === userId) return;
        await this.assertLinkable(manager, tenantId, userId, id);
        const previous = employee.userId;
        await manager
          .getRepository(Employee)
          .update({ id, tenantId }, { userId });
        await this.auditService.record(
          {
            tenantId,
            action: 'employee.user_linked',
            entityType: 'employee',
            entityId: id,
            changes: { before: { userId: previous }, after: { userId } },
          },
          manager,
        );
      });
    } catch (error) {
      throw this.uniqueError(error);
    }
    return this.findOne(tenantId, id, scope);
  }

  async unlinkUser(
    tenantId: string,
    id: string,
    scope: BranchScope = branchScope(),
  ) {
    await this.dataSource.transaction(async (manager) => {
      const employee = await this.load(manager, tenantId, id, true, scope);
      if (!employee.userId) return;
      await manager
        .getRepository(Employee)
        .update({ id, tenantId }, { userId: null });
      await this.auditService.record(
        {
          tenantId,
          action: 'employee.user_unlinked',
          entityType: 'employee',
          entityId: id,
          changes: {
            before: { userId: employee.userId },
            after: { userId: null },
          },
        },
        manager,
      );
    });
    return this.findOne(tenantId, id, scope);
  }

  /**
   * Deactivate (the employee left). A linked login is suspended in the store,
   * which also ends its sessions (UsersService); that needs users.manage.
   */
  async deactivate(
    tenantId: string,
    actor: AuthUser,
    id: string,
    dto: DeactivateEmployeeDto,
  ) {
    const scope = branchScope(actor);
    const employee = await this.load(
      this.dataSource.manager,
      tenantId,
      id,
      false,
      scope,
    );
    if (employee.status === EmployeeStatus.INACTIVE) {
      return this.view(employee);
    }
    let membershipSuspended = false;
    assertDateRange(
      employee.hireDate,
      dto.terminationDate?.slice(0, 10),
      'The termination date is before the hire date',
    );
    if (employee.userId) {
      const membership = await this.dataSource
        .getRepository(TenantMembership)
        .findOne({ where: { tenantId, userId: employee.userId } });
      if (membership?.status === MembershipStatus.ACTIVE) {
        if (!can(actor, 'users.manage')) {
          throw new ForbiddenException({
            message:
              "This employee signs in: deactivating them also suspends their login, which needs 'users.manage'",
            error: 'Forbidden',
            missingPermissions: ['users.manage'],
            approvable: false,
          });
        }
        // Suspends the membership and revokes the member's sessions (audited there)
        await this.usersService.update(tenantId, actor, employee.userId, {
          status: MembershipStatus.SUSPENDED,
        });
        membershipSuspended = true;
      }
    }
    const now = new Date();
    const terminationDate = (
      dto.terminationDate ??
      todayIn(await storeTimezone(this.dataSource.manager, tenantId))
    ).slice(0, 10);
    await this.dataSource.transaction(async (manager) => {
      await manager
        .getRepository(Employee)
        .update(
          { id, tenantId },
          { status: EmployeeStatus.INACTIVE, terminationDate },
        );
      // Still clocked in: the record ends now
      await manager
        .getRepository(EmployeeAttendance)
        .update(
          { tenantId, employeeId: id, clockOut: IsNull() },
          { clockOut: now, note: 'Clocked out on deactivation' },
        );
      await this.auditService.record(
        {
          tenantId,
          action: 'employee.deactivated',
          entityType: 'employee',
          entityId: id,
          reason: dto.reason?.trim() || null,
          changes: {
            before: { status: employee.status },
            after: { status: EmployeeStatus.INACTIVE, terminationDate },
          },
          metadata: { userId: employee.userId, membershipSuspended },
        },
        manager,
      );
    });
    return this.findOne(tenantId, id, scope);
  }

  /** Back at work. A suspended login is re-enabled from Users, not here. */
  async reactivate(
    tenantId: string,
    id: string,
    scope: BranchScope = branchScope(),
  ) {
    await this.dataSource.transaction(async (manager) => {
      const employee = await this.load(manager, tenantId, id, true, scope);
      if (employee.status === EmployeeStatus.ACTIVE) return;
      await manager
        .getRepository(Employee)
        .update(
          { id, tenantId },
          { status: EmployeeStatus.ACTIVE, terminationDate: null },
        );
      await this.auditService.record(
        {
          tenantId,
          action: 'employee.reactivated',
          entityType: 'employee',
          entityId: id,
          changes: {
            before: {
              status: employee.status,
              terminationDate: employee.terminationDate,
            },
            after: { status: EmployeeStatus.ACTIVE, terminationDate: null },
          },
        },
        manager,
      );
    });
    return this.findOne(tenantId, id, scope);
  }

  // ---------------------------------------------------------------------------
  // Attendance
  // ---------------------------------------------------------------------------

  /** POS: the signed-in user's employee and whether they are clocked in */
  async myAttendance(tenantId: string, user: AuthUser) {
    const employee = await this.dataSource
      .getRepository(Employee)
      .findOne({ where: { tenantId, userId: user.id } });
    if (!employee) return { employee: null, open: null };
    const open = await this.dataSource
      .getRepository(EmployeeAttendance)
      .findOne({
        where: { tenantId, employeeId: employee.id, clockOut: IsNull() },
      });
    return {
      employee: {
        id: employee.id,
        name: `${employee.firstName} ${employee.lastName}`.trim(),
        status: employee.status,
      },
      open: open ? attendanceView(open) : null,
    };
  }

  /** POS clock in / out for the signed-in user's linked employee */
  async clock(tenantId: string, user: AuthUser, dto: ClockDto) {
    try {
      const record = await this.dataSource.transaction(async (manager) => {
        const employee = await manager.getRepository(Employee).findOne({
          where: { tenantId, userId: user.id },
          lock: { mode: 'pessimistic_write' },
        });
        if (!employee) {
          throw new NotFoundException(
            'Your account is not linked to an employee: ask a manager',
          );
        }
        if (employee.status !== EmployeeStatus.ACTIVE) {
          throw new ForbiddenException('This employee is not active');
        }
        const repo = manager.getRepository(EmployeeAttendance);
        const open = await repo.findOne({
          where: { tenantId, employeeId: employee.id, clockOut: IsNull() },
        });
        const now = new Date();
        let saved: EmployeeAttendance;
        if (dto.action === 'in') {
          if (open) throw new ConflictException('You are already clocked in');
          const branchId = await this.clockInBranch(
            manager,
            employee.id,
            dto.branchId,
            branchScope(user),
          );
          saved = await repo.save(
            repo.create({
              tenantId,
              employeeId: employee.id,
              clockIn: now,
              clockOut: null,
              branchId,
              source: AttendanceSource.POS,
              note: clean(dto.note),
              recordedById: user.id,
            }),
          );
        } else {
          if (!open) throw new ConflictException('You are not clocked in');
          open.clockOut = now < open.clockIn ? open.clockIn : now;
          if (dto.note?.trim()) open.note = dto.note.trim();
          saved = await repo.save(open);
        }
        await this.auditService.record(
          {
            tenantId,
            action: `attendance.clock_${dto.action}`,
            entityType: 'employee',
            entityId: employee.id,
            metadata: {
              attendanceId: saved.id,
              source: AttendanceSource.POS,
              branchId: saved.branchId,
            },
          },
          manager,
        );
        return saved;
      });
      return attendanceView(record);
    } catch (error) {
      if (
        isPgError(error, PG_UNIQUE_VIOLATION, 'uq_employee_attendance_open')
      ) {
        throw new ConflictException('You are already clocked in');
      }
      throw error;
    }
  }

  /** Admin: record a shift worked (e.g. a forgotten clock-in) */
  async recordAttendance(
    tenantId: string,
    actor: AuthUser,
    employeeId: string,
    dto: RecordAttendanceDto,
  ) {
    const clockIn = new Date(dto.clockIn);
    const clockOut = dto.clockOut ? new Date(dto.clockOut) : null;
    assertShiftLength(clockIn, clockOut);
    const scope = branchScope(actor);
    try {
      const record = await this.dataSource.transaction(async (manager) => {
        const employee = await this.load(
          manager,
          tenantId,
          employeeId,
          false,
          scope,
        );
        // A branch-limited user records shifts at their own branches only (a
        // record without a branch would be outside their reach); by default at
        // the employee's first branch among theirs
        let branchId = dto.branchId ?? null;
        if (branchId) {
          if (!canAccessBranch(branchId, scope)) {
            throw new BadRequestException('Branch not found');
          }
          await this.assertBranch(manager, tenantId, branchId);
        } else if (scope !== null) {
          branchId =
            (employee.branches ?? []).find((b) =>
              canAccessBranch(b.branchId, scope),
            )?.branchId ?? null;
        }
        const repo = manager.getRepository(EmployeeAttendance);
        const saved = await repo.save(
          repo.create({
            tenantId,
            employeeId,
            clockIn,
            clockOut,
            branchId,
            source: AttendanceSource.ADMIN,
            note: dto.note.trim(),
            recordedById: actor.id,
          }),
        );
        await this.auditService.record(
          {
            tenantId,
            action: 'attendance.recorded',
            entityType: 'employee',
            entityId: employeeId,
            reason: saved.note,
            metadata: {
              attendanceId: saved.id,
              clockIn: clockIn.toISOString(),
              clockOut: clockOut?.toISOString() ?? null,
            },
          },
          manager,
        );
        return saved;
      });
      return attendanceView(record);
    } catch (error) {
      if (
        isPgError(error, PG_UNIQUE_VIOLATION, 'uq_employee_attendance_open')
      ) {
        throw new ConflictException(
          'This employee is already clocked in: close that record first',
        );
      }
      throw error;
    }
  }

  /** Admin: clock out a record left open */
  async closeAttendance(
    tenantId: string,
    attendanceId: string,
    dto: CloseAttendanceDto,
    scope: BranchScope = branchScope(),
  ) {
    const record = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(EmployeeAttendance);
      const found = await repo.findOne({
        where: { id: attendanceId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      // Outside the user's branches (record or employee): not found
      if (
        !found ||
        !canAccessBranch(found.branchId, scope) ||
        !(await this.isVisible(manager, found.employeeId, scope))
      ) {
        throw new NotFoundException('Attendance record not found');
      }
      if (found.clockOut) {
        throw new ConflictException('This record is already clocked out');
      }
      const clockOut = new Date(dto.clockOut);
      // No 24-hour cap here: closing a forgotten clock-in must stay possible
      if (clockOut < found.clockIn) {
        throw new BadRequestException('The clock-out is before the clock-in');
      }
      found.clockOut = clockOut;
      if (dto.note?.trim()) found.note = dto.note.trim();
      const saved = await repo.save(found);
      await this.auditService.record(
        {
          tenantId,
          action: 'attendance.closed',
          entityType: 'employee',
          entityId: found.employeeId,
          reason: dto.note?.trim() || null,
          metadata: { attendanceId, clockOut: clockOut.toISOString() },
        },
        manager,
      );
      return saved;
    });
    return attendanceView(record);
  }

  /** Hours per employee over a date range, with the records */
  async attendanceReport(
    tenantId: string,
    query: AttendanceReportQueryDto,
    scope: BranchScope = branchScope(),
  ) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (!(to > from)) {
      throw new BadRequestException(
        'The end of the range must be after its start',
      );
    }
    if (to.getTime() - from.getTime() > MAX_REPORT_DAYS * 86_400_000) {
      throw new BadRequestException(
        `A report covers at most ${MAX_REPORT_DAYS} days`,
      );
    }
    // A branch or employee outside the user's branches: not found
    if (query.branchId && !canAccessBranch(query.branchId, scope)) {
      throw new NotFoundException('Branch not found');
    }
    if (query.employeeId) {
      await this.load(
        this.dataSource.manager,
        tenantId,
        query.employeeId,
        false,
        scope,
      );
    }
    const qb = this.dataSource
      .getRepository(EmployeeAttendance)
      .createQueryBuilder('a')
      .innerJoinAndSelect('a.employee', 'e')
      .where('a.tenantId = :tenantId', { tenantId })
      .andWhere('a.clockIn < :to', { to })
      .andWhere('(a.clockOut IS NULL OR a.clockOut > :from)', { from })
      .orderBy('a.clockIn', 'ASC');
    if (query.employeeId) {
      qb.andWhere('a.employeeId = :employeeId', {
        employeeId: query.employeeId,
      });
    }
    if (query.branchId) {
      qb.andWhere('a.branchId = :branchId', { branchId: query.branchId });
    }
    // Limited to some branches: the shifts worked there
    const shifts = branchFilterSql('a', 'branchId', scope);
    if (shifts) qb.andWhere(shifts.sql, shifts.params);
    const rows = await qb.getMany();
    const now = new Date();
    const window = { from, to };
    const byEmployee = new Map<
      string,
      { employee: Employee; records: EmployeeAttendance[] }
    >();
    for (const row of rows) {
      const entry = byEmployee.get(row.employeeId) ?? {
        employee: row.employee!,
        records: [],
      };
      entry.records.push(row);
      byEmployee.set(row.employeeId, entry);
    }
    const employees = [...byEmployee.values()].map(({ employee, records }) => ({
      employeeId: employee.id,
      name: `${employee.firstName} ${employee.lastName}`.trim(),
      employeeCode: employee.employeeCode,
      hours: totalHours(records, window, now),
      shifts: records.length,
      open: records.some((r) => !r.clockOut),
      records: records.map((r) => ({
        ...attendanceView(r),
        hours: spanHours(r, window, now),
      })),
    }));
    employees.sort((a, b) => a.name.localeCompare(b.name));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      totalHours:
        Math.round(employees.reduce((sum, e) => sum + e.hours, 0) * 100) / 100,
      employees,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * The employee, with its branches and login. Outside the scope (none of its
   * branches is one of the user's): not found, so ids can't be probed.
   */
  private async load(
    manager: EntityManager,
    tenantId: string,
    id: string,
    lock = false,
    scope: BranchScope = branchScope(),
  ): Promise<Employee> {
    const repo = manager.getRepository(Employee);
    const employee = await repo.findOne({
      where: { id, tenantId },
      ...(lock ? { lock: { mode: 'pessimistic_write' as const } } : {}),
    });
    if (!employee) throw new NotFoundException('Employee not found');
    employee.branches = await manager
      .getRepository(EmployeeBranch)
      .find({ where: { employeeId: id }, order: { isPrimary: 'DESC' } });
    if (!inScope(employee.branches, scope)) {
      throw new NotFoundException('Employee not found');
    }
    if (employee.userId) {
      const [user] = await manager.query<
        {
          id: string;
          email: string;
          firstName: string | null;
          lastName: string | null;
        }[]
      >(`SELECT id, email, "firstName", "lastName" FROM users WHERE id = $1`, [
        employee.userId,
      ]);
      employee.user = (user as Employee['user']) ?? null;
    }
    return employee;
  }

  /** The user must be a member of the store and not linked to another employee */
  private async assertLinkable(
    manager: EntityManager,
    tenantId: string,
    userId: string,
    employeeId?: string,
  ) {
    const member = await manager
      .getRepository(TenantMembership)
      .findOne({ where: { tenantId, userId } });
    if (!member) {
      throw new BadRequestException(
        'This account is not a member of the store',
      );
    }
    const other = await manager
      .getRepository(Employee)
      .findOne({ where: { tenantId, userId } });
    if (other && other.id !== employeeId) {
      throw new ConflictException(
        `This account is already linked to ${other.firstName} ${other.lastName}`,
      );
    }
  }

  /** Is the employee assigned to one of the scope's branches? */
  private async isVisible(
    manager: EntityManager,
    employeeId: string,
    scope: BranchScope,
  ): Promise<boolean> {
    if (scope === null) return true;
    const branches = await manager
      .getRepository(EmployeeBranch)
      .find({ where: { employeeId } });
    return inScope(branches, scope);
  }

  /**
   * Branch of a POS clock-in: one the employee is assigned to and the signed-in
   * user works in; by default the first such (primary first). An employee
   * without a branch clocks in without one (every-branch users only).
   */
  private async clockInBranch(
    manager: EntityManager,
    employeeId: string,
    requested: string | undefined,
    scope: BranchScope,
  ): Promise<string | null> {
    const assigned = (
      await manager
        .getRepository(EmployeeBranch)
        .find({ where: { employeeId }, order: { isPrimary: 'DESC' } })
    )
      .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
      .map((b) => b.branchId)
      .filter((id) => canAccessBranch(id, scope));
    if (requested) {
      if (!assigned.includes(requested)) {
        throw new ForbiddenException(
          'You are not assigned to this branch: ask a manager',
        );
      }
      return requested;
    }
    if (assigned.length) return assigned[0];
    // Every-branch user whose employee has no branch at all
    if (scope === null) return null;
    throw new ForbiddenException(
      'You are not assigned to a branch you can clock in at: ask a manager',
    );
  }

  /**
   * Branch assignments a user may set. Every-branch users: as given. A user
   * limited to some branches gives only their own (at least one, so the
   * employee stays in their reach), and the employee's assignments at other
   * branches are kept as they are, including which one is primary.
   */
  private scopedBranchInput(
    input: EmployeeBranchInput[],
    current: EmployeeBranch[] | undefined,
    scope: BranchScope,
  ): EmployeeBranchInput[] {
    if (scope === null) return input;
    if (!input.length) {
      throw new BadRequestException(
        'Assign at least one of your branches to the employee',
      );
    }
    if (input.some((b) => !scope.includes(b.branchId))) {
      throw new ForbiddenException(
        'You can only assign the branches you work in',
      );
    }
    const kept = (current ?? [])
      .filter((b) => !scope.includes(b.branchId))
      .map((b) => ({ branchId: b.branchId, isPrimary: b.isPrimary }));
    if (kept.some((b) => b.isPrimary) && input.some((b) => b.isPrimary)) {
      throw new ForbiddenException(
        "The employee's primary branch is not one of yours: it can't be changed here",
      );
    }
    return [...input, ...kept];
  }

  private async assertBranch(
    manager: EntityManager,
    tenantId: string,
    branchId: string,
  ) {
    const found = await manager
      .getRepository(Branch)
      .count({ where: { id: branchId, tenantId } });
    if (!found) throw new BadRequestException('Branch not found');
  }

  /**
   * Replace the employee's branch assignments. At most one primary branch; when
   * none is marked, the first one is primary.
   */
  async setBranches(
    manager: EntityManager,
    tenantId: string,
    employeeId: string,
    input: EmployeeBranchInput[],
  ) {
    const unique = [...new Map(input.map((b) => [b.branchId, b])).values()];
    if (unique.filter((b) => b.isPrimary).length > 1) {
      throw new BadRequestException(
        'Only one branch can be the primary branch',
      );
    }
    if (unique.length > 0) {
      const found = await manager.getRepository(Branch).find({
        where: { tenantId, id: In(unique.map((b) => b.branchId)) },
        select: { id: true },
      });
      if (found.length !== unique.length) {
        throw new BadRequestException('Branch not found');
      }
    }
    const hasPrimary = unique.some((b) => b.isPrimary);
    const rows = unique.map((b, index) => ({
      branchId: b.branchId,
      isPrimary: hasPrimary ? !!b.isPrimary : index === 0,
    }));
    const repo = manager.getRepository(EmployeeBranch);
    await repo.delete({ employeeId });
    if (rows.length > 0) {
      await repo.save(
        rows.map((row) => repo.create({ tenantId, employeeId, ...row })),
      );
    }
    return rows;
  }

  private uniqueError(error: unknown) {
    if (isPgError(error, PG_UNIQUE_VIOLATION, 'uq_employee_code')) {
      return new ConflictException('Another employee has this employee code');
    }
    if (isPgError(error, PG_UNIQUE_VIOLATION, 'uq_employee_user')) {
      return new ConflictException(
        'This account is already linked to another employee',
      );
    }
    return error;
  }

  private view(e: Employee) {
    return {
      id: e.id,
      firstName: e.firstName,
      lastName: e.lastName,
      name: `${e.firstName} ${e.lastName}`.trim(),
      jobTitle: e.jobTitle,
      phone: e.phone,
      email: e.email,
      employeeCode: e.employeeCode,
      status: e.status,
      hireDate: e.hireDate,
      terminationDate: e.terminationDate,
      notes: e.notes,
      userId: e.userId,
      user: e.user
        ? {
            id: e.user.id,
            email: e.user.email,
            name:
              [e.user.firstName, e.user.lastName].filter(Boolean).join(' ') ||
              e.user.email,
          }
        : null,
      branches: branchList(e.branches),
      version: e.version,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    };
  }
}

/** Assigned to one of the scope's branches? (null scope: always) */
function inScope(branches: EmployeeBranch[] | undefined, scope: BranchScope) {
  if (scope === null) return true;
  return (branches ?? []).some((b) => scope.includes(b.branchId));
}

function branchList(branches: EmployeeBranch[] | undefined) {
  return (branches ?? [])
    .map((b) => ({ branchId: b.branchId, isPrimary: b.isPrimary }))
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary));
}

function attendanceView(a: EmployeeAttendance) {
  return {
    id: a.id,
    employeeId: a.employeeId,
    clockIn: a.clockIn,
    clockOut: a.clockOut,
    branchId: a.branchId,
    source: a.source,
    note: a.note,
  };
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function pick<T extends object, K extends keyof T>(
  source: T,
  keys: readonly K[],
): Pick<T, K> {
  return Object.fromEntries(keys.map((k) => [k, source[k]])) as Pick<T, K>;
}
