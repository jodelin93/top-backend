import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Permission } from '../auth/permissions';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { DataSource, EntityManager, SelectQueryBuilder } from 'typeorm';
import {
  canAccessBranch,
  hasAllBranches,
  scopedBranchIds,
} from '../auth/branch-scope';
import {
  ConflictCase,
  ConflictCaseStatus,
  ConflictCaseType,
} from '../database/entities/conflict-case.entity';
import { Sale } from '../database/entities/sale.entity';
import { AuditService } from '../audit/audit.service';
import { paginate, PaginatedResult } from '../common/dto/pagination.dto';
import { ListConflictCasesQueryDto, ResolveConflictCaseDto } from './sales.dto';

export interface OpenConflictCaseInput {
  tenantId: string;
  type: ConflictCaseType;
  saleId?: string | null;
  deviceId?: string | null;
  details: Record<string, unknown>;
}

/**
 * Open a review case inside the caller's transaction (e.g. the sale that caused it),
 * so the case exists exactly when the sale does
 */
export function openConflictCase(
  manager: EntityManager,
  input: OpenConflictCaseInput,
): Promise<ConflictCase> {
  return manager.save(
    manager.create(ConflictCase, {
      tenantId: input.tenantId,
      type: input.type,
      status: ConflictCaseStatus.OPEN,
      saleId: input.saleId ?? null,
      deviceId: input.deviceId ?? null,
      details: input.details,
    }),
  );
}

export type ConflictCaseRow = ConflictCase & {
  sale: Pick<Sale, 'id' | 'saleNumber' | 'offlineNumber' | 'saleDate'> | null;
};

/**
 * Review queue: sales the system accepted but a person must check
 * (offline oversells, offline discounts nobody approved, ...)
 */

/**
 * Branch of a review case (alias c): its sale's, else the register of its
 * till's. Cases with neither are store-level (every-branch users only).
 */
const CASE_BRANCH_SQL = `COALESCE(
  (SELECT cs."branchId" FROM sales cs WHERE cs.id = c."saleId"),
  (SELECT cr."branchId" FROM devices cd JOIN registers cr ON cr.id = cd."registerId" WHERE cd.id = c."deviceId"))`;

/**
 * Who works each kind of case (any of the permissions): stock people fix
 * oversells, sales reviewers offline prices and leases, shift managers the
 * cash of late or shift-less uploads.
 */
export const CASE_PERMISSIONS: Record<ConflictCaseType, Permission[]> = {
  [ConflictCaseType.OFFLINE_OVERSELL]: ['inventory.adjust'],
  [ConflictCaseType.OFFLINE_PRICE]: ['sales.review'],
  [ConflictCaseType.OFFLINE_LEASE]: ['sales.review'],
  [ConflictCaseType.LOST_DEVICE]: ['sales.review', 'devices.manage'],
  [ConflictCaseType.LATE_SHIFT]: ['shifts.manage'],
  [ConflictCaseType.OFFLINE_NO_SHIFT]: ['shifts.manage'],
};

/** The case types a user may see and close */
export function caseTypesFor(
  permissions: readonly string[] | undefined,
): ConflictCaseType[] {
  return (Object.keys(CASE_PERMISSIONS) as ConflictCaseType[]).filter((type) =>
    CASE_PERMISSIONS[type].some((p) => permissions?.includes(p)),
  );
}

/** Only the case types the user works (none: nothing matches) */
function applyTypeScope(
  qb: SelectQueryBuilder<ConflictCase>,
  permissions: readonly string[] | undefined,
) {
  qb.andWhere('c.type IN (:...caseTypes)', {
    // A never-matching value keeps the SQL valid when the list is empty
    caseTypes: [...caseTypesFor(permissions), '-'],
  });
}

/** Branch-limited users see the review cases of their branches (spec §9) */
function applyCaseScope(qb: SelectQueryBuilder<ConflictCase>) {
  const branches = scopedBranchIds();
  if (branches) {
    qb.andWhere(`${CASE_BRANCH_SQL} = ANY(:caseBranches)`, {
      caseBranches: branches,
    });
  }
}

@Injectable()
export class ConflictCasesService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {}

  async findAll(
    tenantId: string,
    query: ListConflictCasesQueryDto,
    permissions: readonly string[] | undefined,
  ): Promise<PaginatedResult<ConflictCaseRow>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const qb = this.dataSource
      .getRepository(ConflictCase)
      .createQueryBuilder('c')
      .where('c.tenantId = :tenantId', { tenantId })
      .orderBy('c.openedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.status) {
      qb.andWhere('c.status = :status', { status: query.status });
    }
    if (query.type) qb.andWhere('c.type = :type', { type: query.type });
    if (query.saleId) {
      qb.andWhere('c.saleId = :saleId', { saleId: query.saleId });
    }
    if (query.deviceId) {
      qb.andWhere('c.deviceId = :deviceId', { deviceId: query.deviceId });
    }
    applyTypeScope(qb, permissions);
    applyCaseScope(qb);
    const [cases, total] = await qb.getManyAndCount();

    // The sale number is what people recognise; load it for the page in one query
    const saleIds = [
      ...new Set(cases.map((c) => c.saleId).filter(Boolean)),
    ] as string[];
    const sales = saleIds.length
      ? await this.dataSource
          .getRepository(Sale)
          .createQueryBuilder('sale')
          .select([
            'sale.id',
            'sale.saleNumber',
            'sale.offlineNumber',
            'sale.saleDate',
          ])
          .where('sale.tenantId = :tenantId AND sale.id IN (:...saleIds)', {
            tenantId,
            saleIds,
          })
          .getMany()
      : [];
    const byId = new Map(sales.map((s) => [s.id, s]));
    const rows = cases.map((c) =>
      Object.assign(c, {
        sale: c.saleId ? (byId.get(c.saleId) ?? null) : null,
      }),
    );
    return paginate(rows, total, page, limit);
  }

  /** Open cases the user works, for the admin badge */
  countOpen(
    tenantId: string,
    permissions: readonly string[] | undefined,
  ): Promise<number> {
    const qb = this.dataSource
      .getRepository(ConflictCase)
      .createQueryBuilder('c')
      .where('c.tenantId = :tenantId AND c.status = :open', {
        tenantId,
        open: ConflictCaseStatus.OPEN,
      });
    applyTypeScope(qb, permissions);
    applyCaseScope(qb);
    return qb.getCount();
  }

  async resolve(
    tenantId: string,
    user: Pick<AuthUser, 'id' | 'permissions'>,
    id: string,
    dto: ResolveConflictCaseDto,
  ): Promise<ConflictCase> {
    const userId = user.id;
    return this.dataSource.transaction(async (manager) => {
      const found = await manager.findOne(ConflictCase, {
        where: { id, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!found) throw new NotFoundException('Review case not found');
      if (!hasAllBranches()) {
        const [row] = await manager.query<{ branchId: string | null }[]>(
          `SELECT ${CASE_BRANCH_SQL} AS "branchId" FROM conflict_cases c WHERE c.id = $1`,
          [id],
        );
        if (!canAccessBranch(row?.branchId)) {
          throw new NotFoundException('Review case not found');
        }
      }
      const needed = CASE_PERMISSIONS[found.type] ?? ['sales.review'];
      if (!needed.some((p) => user.permissions?.includes(p))) {
        throw new ForbiddenException({
          message: 'You are not allowed to close this kind of case',
          error: 'Forbidden',
          missingPermissions: needed,
        });
      }
      if (found.status !== ConflictCaseStatus.OPEN) {
        throw new ConflictException(`This case is already ${found.status}`);
      }
      found.status =
        dto.status === 'dismissed'
          ? ConflictCaseStatus.DISMISSED
          : ConflictCaseStatus.RESOLVED;
      found.resolvedAt = new Date();
      found.resolvedById = userId;
      found.resolutionNote = dto.note.trim();
      const saved = await manager.save(found);
      await this.auditService.record(
        {
          tenantId,
          action: `conflict_case.${found.status}`,
          entityType: 'conflict_case',
          entityId: id,
          reason: found.resolutionNote,
          metadata: { type: found.type, saleId: found.saleId },
        },
        manager,
      );
      return saved;
    });
  }
}
