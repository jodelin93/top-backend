import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  assertBranchAccess,
  branchScope,
  hasAllBranches,
  registerBranchId,
  scopedBranchIds,
} from '../auth/branch-scope';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import {
  DenominationCount,
  Shift,
  ShiftStatus,
} from '../database/entities/shift.entity';
import {
  CashMovement,
  CashMovementType,
  LEDGER_ONLY_TYPES,
} from '../database/entities/cash-movement.entity';
import { CashDenominationSet } from '../database/entities/cash-denomination-set.entity';
import {
  DrawerPolicy,
  Register,
  RegisterStatus,
} from '../database/entities/register.entity';
import { Drawer, DrawerStatus } from '../database/entities/drawer.entity';
import { Branch } from '../database/entities/branch.entity';
import {
  ShiftCorrection,
  ShiftCorrectionType,
} from '../database/entities/shift-correction.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { SettingsService, StoreSettings } from '../settings/settings.service';
import { requestContext } from '../common/context/request-context';
import { paginate } from '../common/dto/pagination.dto';
import { nextDocumentNumber } from '../common/utils/sequence';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { round2 } from '../sales/sale-calculator';
import { exchangeRate } from '../currency/currency-math';
import { OutboxService } from '../platform/outbox/outbox.service';
import { businessDateOf } from './business-date';
import { syncSaleCashMovements } from './sale-ledger';
import {
  CashBreakdown,
  checkCloseAuthority,
  countTotal,
  defaultDenominations,
  evaluateForeignCash,
  evaluateVariance,
  expectedCash,
  foreignOpeningFloats,
  movementCurrency,
  ForeignCashResult,
  normalizeDenominations,
  VarianceResult,
  withOpeningForeign,
} from './shift-math';
import {
  CloseShiftDto,
  CountDto,
  CreateCashMovementDto,
  CreateShiftCorrectionDto,
  DrawerOpenDto,
  HandoverShiftDto,
  ListShiftsQueryDto,
  OpenShiftDto,
  SetDenominationsDto,
  StartCloseDto,
} from './shifts.dto';

export interface OpenShiftRef {
  id: string;
  shiftNumber: string;
  status: ShiftStatus;
  registerId: string;
  drawerId: string;
  shared: boolean;
  openedById: string;
  openedAt: Date;
}

/** Input for other modules posting cash in/out of a drawer (returns, expenses) */
export interface RecordCashMovementInput {
  tenantId: string;
  shiftId: string;
  type: CashMovementType;
  amount: number;
  // Another currency the store accepts; null/omitted = the shift's currency
  currencyCode?: string | null;
  userId: string;
  approverId?: string | null;
  reason?: string | null;
  reference?: string | null;
  expenseId?: string | null;
  // e.g. sourceType 'return' + the return's id: unique, so it can never post twice
  sourceType?: string | null;
  sourceId?: string | null;
  idempotencyKey?: string | null;
}

export interface PaymentMethodTotal {
  paymentMethodId: string;
  name: string;
  methodType: string;
  count: number;
  amount: number;
}

export interface ShiftSalesSummary {
  count: number;
  total: number;
  voidedCount: number;
  voidedTotal: number;
  byPaymentMethod: PaymentMethodTotal[];
}

/**
 * Sales filed under a shift after it closed (e.g. offline sales uploaded late).
 * A closed shift's figures are frozen; these are shown next to them, never folded in.
 */
export interface LateSalesSummary {
  count: number;
  byCurrency: { currencyCode: string; count: number; total: number }[];
  // Cash kept (tendered − change) in the shift's currency
  cash: number;
  // Cash kept in other currencies, in that currency
  foreignCash: { currencyCode: string; amount: number }[];
  sales: {
    id: string;
    saleNumber: string;
    saleDate: string;
    uploadedAt: string;
    total: number;
    currencyCode: string;
  }[];
}

export interface ZReport {
  generatedAt: string;
  final: boolean;
  shift: {
    id: string;
    shiftNumber: string;
    status: ShiftStatus;
    registerId: string;
    registerName: string | null;
    currencyCode: string;
    openedAt: string;
    openedBy: string | null;
    closedAt: string | null;
    closedBy: string | null;
    approvedBy: string | null;
    blindCount: boolean;
    forceClosed: boolean;
    businessDate?: string | null;
  };
  sales: ShiftSalesSummary;
  cash: CashBreakdown & { expected: number };
  movements: {
    id: string;
    type: CashMovementType;
    amount: number;
    // null = the shift's currency
    currencyCode: string | null;
    reason: string | null;
    reference: string | null;
    createdAt: string;
    user: string | null;
  }[];
  count: {
    denominations: DenominationCount[] | null;
    counted: number | null;
  };
  variance: {
    expected: number | null;
    counted: number | null;
    variance: number | null;
    tolerance: number;
    overTolerance: boolean;
    reason: string | null;
  };
  // Counted vs expected per other currency (closed shifts)
  foreignCount: ForeignCashResult[] | null;
  notes: string | null;
  // Closed shifts: sales uploaded after the close, computed on read (not frozen)
  lateSales?: LateSalesSummary | null;
  // Closed shifts: manager corrections, computed on read (not frozen)
  corrections?: CorrectionsSummary | null;
}

/**
 * Manager corrections of a closed shift (linked records, the shift stays frozen),
 * shown next to the frozen figures with the corrected result
 */
export interface CorrectionsSummary {
  corrections: {
    id: string;
    type: ShiftCorrectionType;
    amount: number;
    reason: string;
    createdAt: string;
    createdBy: string | null;
    approvedBy: string | null;
  }[];
  expectedAdjustment: number;
  countedAdjustment: number;
  expected: number | null;
  counted: number | null;
  variance: number | null;
}

/** Everything that went through the drawer, sales included (trace, not the count) */
export interface DrawerLedger {
  shiftId: string;
  shiftNumber: string;
  currencyCode: string;
  entries: (ReturnType<ShiftsService['movementView']> & {
    // in / out of the drawer, or none (drawer opened without cash)
    direction: 'in' | 'out' | 'none';
    // false for the per-sale and no-sale rows (cash sales come from payments)
    inExpectedCash: boolean;
  })[];
  cashSalesTotal: number;
  saleCount: number;
  noSaleCount: number;
}

// How many late sales to list individually
const LATE_SALES_LISTED = 50;

// Sales that put cash in the drawer (voided / held / draft ones did not)
const COUNTED_SALE_STATUSES = ['completed', 'refunded', 'partially_refunded'];
const COUNTED_PAYMENT_STATUSES = ['completed', 'captured', 'refunded'];

const ACTIVE_STATUSES = [ShiftStatus.OPEN, ShiftStatus.CLOSING];

const can = (user: AuthUser, permission: string) =>
  user.permissions?.some((p) => p === permission) ?? false;

@Injectable()
export class ShiftsService {
  private readonly logger = new Logger(ShiftsService.name);
  // Whether sales.shiftId exists (added by the sales module); re-checked until found
  private salesShiftColumn: { exists: boolean; checkedAt: number } | null =
    null;

  constructor(
    @InjectRepository(Shift) private shiftRepository: Repository<Shift>,
    @InjectRepository(CashMovement)
    private movementRepository: Repository<CashMovement>,
    @InjectRepository(CashDenominationSet)
    private denominationRepository: Repository<CashDenominationSet>,
    private dataSource: DataSource,
    private auditService: AuditService,
    private approvalsService: ApprovalsService,
    private settingsService: SettingsService,
    // Domain events (shift.opened/closed, cash.movement); optional for unit tests
    @Optional() private outbox?: OutboxService,
  ) {}

  // ---------------------------------------------------------------------------
  // Contract for other modules
  // ---------------------------------------------------------------------------

  /**
   * The register's current (open or closing) shift, or null.
   * Used by sales to enforce `requireOpenShift` and stamp `sales.shiftId`.
   * Pass the transaction's manager to read inside it.
   */
  async getOpenShift(
    tenantId: string,
    registerId: string,
    manager?: EntityManager,
  ): Promise<OpenShiftRef | null> {
    const repo = manager ? manager.getRepository(Shift) : this.shiftRepository;
    const shifts = await repo.find({
      where: { tenantId, registerId, status: In(ACTIVE_STATUSES) },
      select: {
        id: true,
        shiftNumber: true,
        status: true,
        registerId: true,
        drawerId: true,
        shared: true,
        openedById: true,
        openedAt: true,
      },
      order: { openedAt: 'ASC' },
    });
    if (shifts.length === 0) return null;
    // Several drawers open on the register: the signed-in cashier's own shift,
    // else a shared one (one drawer: its shift, as before)
    const me = requestContext.get()?.userId;
    const shift =
      shifts.find((sh) => me && sh.openedById === me) ??
      shifts.find((sh) => sh.shared) ??
      shifts[0];
    return {
      id: shift.id,
      shiftNumber: shift.shiftNumber,
      status: shift.status,
      registerId: shift.registerId,
      drawerId: shift.drawerId,
      shared: !!shift.shared,
      openedById: shift.openedById,
      openedAt: shift.openedAt,
    };
  }

  /**
   * Post a cash movement to a shift inside the caller's transaction.
   * Extension point for returns: `type: CashMovementType.REFUND` with
   * `sourceType: 'return', sourceId: <return id>`. The shift row is locked and
   * must not be closed. A duplicate expense/source/idempotency key returns the
   * existing row instead of posting twice.
   */
  async recordCashMovement(
    manager: EntityManager,
    input: RecordCashMovementInput,
  ): Promise<CashMovement> {
    const amount = round2(input.amount);
    if (!(amount > 0)) {
      throw new BadRequestException('Cash movement amount must be positive');
    }
    const shift = await this.lockShift(manager, input.tenantId, input.shiftId);
    if (shift.status === ShiftStatus.CLOSED) {
      throw new ConflictException(
        `Shift ${shift.shiftNumber} is closed; cash can no longer be posted to it`,
      );
    }

    const existing = await this.findDuplicateMovement(manager, input);
    if (existing) return existing;

    const repo = manager.getRepository(CashMovement);
    const movement = repo.create({
      tenantId: input.tenantId,
      shiftId: shift.id,
      registerId: shift.registerId,
      type: input.type,
      amount,
      currencyCode: input.currencyCode ?? null,
      userId: input.userId,
      approverId: input.approverId ?? null,
      reason: input.reason ?? null,
      reference: input.reference ?? null,
      expenseId: input.expenseId ?? null,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    const saved = await repo.save(movement);
    await this.auditService.record(
      {
        tenantId: input.tenantId,
        action: `cash_movement.${input.type}`,
        entityType: 'shift',
        entityId: shift.id,
        reason: input.reason ?? null,
        actorId: input.userId,
        approverId: input.approverId ?? undefined,
        metadata: {
          movementId: saved.id,
          amount,
          currencyCode: saved.currencyCode ?? shift.currencyCode,
          expenseId: saved.expenseId,
          sourceType: saved.sourceType,
          sourceId: saved.sourceId,
        },
      },
      manager,
    );
    await this.outbox?.record(manager, {
      tenantId: input.tenantId,
      type: 'cash.movement',
      aggregateId: shift.id,
      aggregateVersion: shift.version ?? null,
      payload: {
        movementId: saved.id,
        shiftId: shift.id,
        registerId: shift.registerId,
        type: saved.type,
        amount,
        currencyCode: saved.currencyCode ?? shift.currencyCode,
        expenseId: saved.expenseId ?? null,
        sourceType: saved.sourceType ?? null,
        sourceId: saved.sourceId ?? null,
      },
    });
    return saved;
  }

  // ---------------------------------------------------------------------------
  // Shift lifecycle
  // ---------------------------------------------------------------------------

  async open(tenantId: string, user: AuthUser, dto: OpenShiftDto) {
    const register = await this.dataSource
      .getRepository(Register)
      .findOne({ where: { id: dto.registerId, tenantId } });
    if (!register) throw new NotFoundException('Register not found');
    assertBranchAccess(user, register.branchId, 'Register not found');
    if (register.status !== RegisterStatus.ACTIVE) {
      throw new BadRequestException('This register is not active');
    }
    const shared = register.drawerPolicy === DrawerPolicy.SHARED;
    const drawer = await this.resolveDrawer(
      this.dataSource.manager,
      tenantId,
      register,
      dto.drawerId,
    );

    // Shared drawer already running: the cashier joins its shift
    if (shared) {
      const active = await this.activeShiftOnDrawer(tenantId, drawer.id);
      if (active) return this.joinShared(tenantId, user, active);
    }

    const denominations = dto.denominations?.filter((d) => d.quantity > 0);
    const openingFloat = denominations?.length
      ? countTotal(denominations)
      : round2(dto.openingFloat ?? 0);
    if (
      denominations?.length &&
      dto.openingFloat !== undefined &&
      round2(dto.openingFloat) !== openingFloat
    ) {
      throw new BadRequestException(
        'The opening float does not match the denomination count',
      );
    }
    const settings = await this.settingsService.getSettings(tenantId);
    const openingForeignCash = foreignOpeningFloats(
      dto.foreignFloats,
      settings.currencyCode,
      settings.exchangeRates,
    );
    const openedAt = new Date();
    const businessDate = await this.businessDateFor(
      this.dataSource.manager,
      register.branchId,
      openedAt,
      settings,
    );

    try {
      const shiftId = await this.dataSource.transaction(async (manager) => {
        const shift = await this.createShift(manager, {
          tenantId,
          register,
          drawer,
          openedById: user.id,
          openedAt,
          openingFloat,
          openingForeignCash,
          denominations: denominations?.length ? denominations : null,
          notes: dto.notes?.trim() || null,
          currencyCode: settings.currencyCode,
          shared,
          businessDate,
          previousShiftId: null,
        });
        return shift.id;
      });
      return this.findOne(tenantId, user, shiftId);
    } catch (error) {
      if (
        isPgError(error, PG_UNIQUE_VIOLATION, 'uq_shift_drawer_active') ||
        isPgError(error, PG_UNIQUE_VIOLATION, 'uq_shift_register_active')
      ) {
        const current = await this.activeShiftOnDrawer(tenantId, drawer.id);
        // Two cashiers opened the shared drawer at once: the second one joins
        if (shared && current) return this.joinShared(tenantId, user, current);
        throw new ConflictException({
          message: `Register ${register.name} already has an open shift${current ? ` (${current.shiftNumber})` : ''}`,
          error: 'Conflict',
          shiftId: current?.id ?? null,
        });
      }
      throw error;
    }
  }

  /**
   * Insert a shift with its opening float movement, audit and event, inside the
   * caller's transaction (open, handover)
   */
  private async createShift(
    manager: EntityManager,
    input: {
      tenantId: string;
      register: Register;
      drawer: Drawer;
      openedById: string;
      openedAt: Date;
      openingFloat: number;
      // Foreign cash in the drawer at opening (typed at opening, or a handover)
      openingForeignCash?: { currencyCode: string; amount: number }[] | null;
      denominations: DenominationCount[] | null;
      notes: string | null;
      currencyCode: string;
      shared: boolean;
      businessDate: string | null;
      previousShiftId: string | null;
    },
  ): Promise<Shift> {
    const { tenantId, register, drawer } = input;
    const shiftNumber = await nextDocumentNumber(manager, {
      table: 'shifts',
      column: 'shiftNumber',
      tenantId,
      prefix: 'SH',
    });
    const repo = manager.getRepository(Shift);
    const shift = await repo.save(
      repo.create({
        tenantId,
        shiftNumber,
        registerId: register.id,
        branchId: register.branchId,
        drawerId: drawer.id,
        shared: input.shared,
        businessDate: input.businessDate,
        previousShiftId: input.previousShiftId,
        status: ShiftStatus.OPEN,
        currencyCode: input.currencyCode,
        openedById: input.openedById,
        openedAt: input.openedAt,
        openingFloat: input.openingFloat,
        openingForeignCash: input.openingForeignCash?.length
          ? input.openingForeignCash
          : null,
        openingDenominations: input.denominations,
        openingNotes: input.notes,
      }),
    );
    if (input.openingFloat > 0) {
      await manager.getRepository(CashMovement).save(
        manager.getRepository(CashMovement).create({
          tenantId,
          shiftId: shift.id,
          registerId: register.id,
          type: CashMovementType.OPENING_FLOAT,
          amount: input.openingFloat,
          userId: input.openedById,
          reason: 'Opening float',
        }),
      );
    }
    await this.auditService.record(
      {
        tenantId,
        action: 'shift.opened',
        entityType: 'shift',
        entityId: shift.id,
        metadata: {
          shiftNumber,
          registerId: register.id,
          drawerId: drawer.id,
          openingFloat: input.openingFloat,
          openedById: input.openedById,
          businessDate: input.businessDate,
          previousShiftId: input.previousShiftId,
        },
      },
      manager,
    );
    await this.outbox?.record(manager, {
      tenantId,
      type: 'shift.opened',
      aggregateId: shift.id,
      aggregateVersion: shift.version ?? null,
      payload: {
        shiftId: shift.id,
        shiftNumber,
        registerId: register.id,
        openingFloat: input.openingFloat,
        openedById: input.openedById,
      },
    });
    return shift;
  }

  /**
   * The drawer to open: the one asked for, else the register's first free
   * active drawer (shared policy: the one already running). A register without
   * any drawer row (created before drawers existed) gets its main drawer.
   */
  private async resolveDrawer(
    manager: EntityManager,
    tenantId: string,
    register: Register,
    drawerId?: string,
  ): Promise<Drawer> {
    const repo = manager.getRepository(Drawer);
    if (drawerId) {
      const drawer = await repo.findOne({
        where: { id: drawerId, tenantId, registerId: register.id },
      });
      if (!drawer) {
        throw new NotFoundException('Drawer not found on this register');
      }
      if (drawer.status !== DrawerStatus.ACTIVE) {
        throw new BadRequestException('This drawer is not active');
      }
      return drawer;
    }
    const drawers = await repo.find({
      where: { tenantId, registerId: register.id },
      order: { code: 'ASC' },
    });
    const active = drawers.filter((d) => d.status === DrawerStatus.ACTIVE);
    if (active.length === 1) return active[0];
    if (active.length > 1) {
      const busy = new Set(
        (
          await manager.getRepository(Shift).find({
            where: {
              tenantId,
              drawerId: In(active.map((d) => d.id)),
              status: In(ACTIVE_STATUSES),
            },
            select: { id: true, drawerId: true },
          })
        ).map((sh) => sh.drawerId),
      );
      const shared = register.drawerPolicy === DrawerPolicy.SHARED;
      return (
        active.find((d) => (shared ? busy.has(d.id) : !busy.has(d.id))) ??
        active[0]
      );
    }
    if (drawers.length > 0) {
      throw new BadRequestException('This register has no active drawer');
    }
    await repo
      .createQueryBuilder()
      .insert()
      .values({
        tenantId,
        registerId: register.id,
        code: 'MAIN',
        name: 'Main drawer',
        status: DrawerStatus.ACTIVE,
      })
      .orIgnore()
      .execute();
    return repo.findOneOrFail({
      where: { tenantId, registerId: register.id, code: 'MAIN' },
    });
  }

  private activeShiftOnDrawer(tenantId: string, drawerId: string) {
    return this.shiftRepository.findOne({
      where: { tenantId, drawerId, status: In(ACTIVE_STATUSES) },
    });
  }

  /** Shared drawer policy: another cashier works on the running shift */
  private async joinShared(tenantId: string, user: AuthUser, shift: Shift) {
    await this.auditService.record({
      tenantId,
      action: 'shift.joined',
      entityType: 'shift',
      entityId: shift.id,
      metadata: {
        shiftNumber: shift.shiftNumber,
        drawerId: shift.drawerId,
        openedById: shift.openedById,
      },
    });
    return { ...(await this.findOne(tenantId, user, shift.id)), joined: true };
  }

  /** Trading day of a moment for the branch (timezone + store cutoff hour) */
  private async businessDateFor(
    manager: EntityManager,
    branchId: string | null,
    at: Date,
    settings: Pick<StoreSettings, 'businessDayCutoffHour'>,
  ): Promise<string> {
    const branch = branchId
      ? await manager
          .getRepository(Branch)
          .findOne({ where: { id: branchId }, select: { timezone: true } })
      : null;
    return businessDateOf(
      at,
      branch?.timezone ?? 'UTC',
      settings.businessDayCutoffHour ?? 0,
    );
  }

  /** Paid-in, paid-out and safe drops from the till */
  async addMovement(
    tenantId: string,
    user: AuthUser,
    shiftId: string,
    dto: CreateCashMovementDto,
  ) {
    const approverId = requestContext.get()?.approverId ?? null;
    const settings = await this.settingsService.getSettings(tenantId);
    const movement = await this.dataSource.transaction(async (manager) => {
      const shift = await this.lockShift(manager, tenantId, shiftId);
      if (shift.status !== ShiftStatus.OPEN) {
        throw new ConflictException(
          'Cash can only be moved while the shift is open',
        );
      }
      return this.recordCashMovement(manager, {
        tenantId,
        shiftId,
        type: dto.type,
        amount: dto.amount,
        currencyCode: movementCurrency(
          dto.currencyCode,
          shift.currencyCode,
          settings.exchangeRates,
        ),
        userId: user.id,
        approverId,
        reason: dto.reason.trim(),
        reference: dto.reference?.trim() || null,
        idempotencyKey: dto.idempotencyKey ?? null,
      });
    });
    return this.movementView(movement);
  }

  /**
   * No-sale: the drawer was opened without a sale (change for a customer, a
   * check). Recorded as a 0-amount 'no_sale' movement with its reason, audited.
   */
  async drawerOpen(
    tenantId: string,
    user: AuthUser,
    shiftId: string,
    dto: DrawerOpenDto,
  ) {
    const reason = dto.reason?.trim() ?? '';
    if (reason.length < 2) {
      throw new BadRequestException('Enter why the drawer is opened');
    }
    const approverId = requestContext.get()?.approverId ?? null;
    const movement = await this.dataSource.transaction(async (manager) => {
      const shift = await this.lockShift(manager, tenantId, shiftId);
      this.assertCanOperate(user, shift);
      if (shift.status !== ShiftStatus.OPEN) {
        throw new ConflictException(
          'The drawer can only be opened while the shift is open',
        );
      }
      const repo = manager.getRepository(CashMovement);
      if (dto.idempotencyKey) {
        const existing = await repo.findOne({
          where: { tenantId, idempotencyKey: dto.idempotencyKey },
        });
        if (existing) {
          if (
            existing.shiftId !== shift.id ||
            existing.type !== CashMovementType.NO_SALE
          ) {
            throw new ConflictException(
              'This idempotency key was already used for another cash movement',
            );
          }
          return existing;
        }
      }
      const saved = await repo.save(
        repo.create({
          tenantId,
          shiftId: shift.id,
          registerId: shift.registerId,
          type: CashMovementType.NO_SALE,
          amount: 0,
          userId: user.id,
          approverId,
          reason,
          idempotencyKey: dto.idempotencyKey ?? null,
        }),
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'cash_movement.no_sale',
          entityType: 'shift',
          entityId: shift.id,
          reason,
          approverId: approverId ?? undefined,
          metadata: { movementId: saved.id, shiftNumber: shift.shiftNumber },
        },
        manager,
      );
      await this.outbox?.record(manager, {
        tenantId,
        type: 'cash.movement',
        aggregateId: shift.id,
        aggregateVersion: shift.version ?? null,
        payload: {
          movementId: saved.id,
          shiftId: shift.id,
          registerId: shift.registerId,
          type: saved.type,
          amount: 0,
          expenseId: null,
          sourceType: null,
          sourceId: null,
        },
      });
      return saved;
    });
    return this.movementView(movement);
  }

  /**
   * Correct a closed shift without reopening it: a linked record (manager),
   * shown on the Z-report as a supplement with the corrected figures
   */
  async addCorrection(
    tenantId: string,
    user: AuthUser,
    shiftId: string,
    dto: CreateShiftCorrectionDto,
  ) {
    const amount = round2(Number(dto.amount));
    if (!Number.isFinite(amount) || amount === 0) {
      throw new BadRequestException('A correction needs a non-zero amount');
    }
    const reason = dto.reason?.trim() ?? '';
    if (reason.length < 2) {
      throw new BadRequestException('Enter the reason for the correction');
    }
    const approverId = requestContext.get()?.approverId ?? null;
    return this.dataSource.transaction(async (manager) => {
      const shift = await this.lockShift(manager, tenantId, shiftId);
      if (shift.status !== ShiftStatus.CLOSED) {
        throw new ConflictException(
          'Only a closed shift is corrected; an open shift uses cash movements',
        );
      }
      const repo = manager.getRepository(ShiftCorrection);
      const saved = await repo.save(
        repo.create({
          tenantId,
          shiftId: shift.id,
          type: dto.type,
          amount,
          reason,
          createdById: user.id,
          approvedById: approverId ?? user.id,
        }),
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'shift.correction_added',
          entityType: 'shift',
          entityId: shift.id,
          reason,
          approverId: approverId ?? undefined,
          metadata: {
            correctionId: saved.id,
            shiftNumber: shift.shiftNumber,
            type: dto.type,
            amount,
          },
        },
        manager,
      );
      return this.correctionsSummary(manager, shift);
    });
  }

  /**
   * The drawer ledger: every movement of the shift, per-sale cash and no-sale
   * openings included. Sales the sale.completed consumer has not recorded yet
   * are added first (idempotent).
   */
  async ledger(
    tenantId: string,
    user: AuthUser,
    shiftId: string,
  ): Promise<DrawerLedger> {
    const shift = await this.getShift(tenantId, shiftId);
    this.assertCanView(user, shift);
    await this.dataSource.transaction(async (manager) => {
      const added = await syncSaleCashMovements(manager, {
        tenantId,
        shiftId: shift.id,
      });
      if (added.length > 0) {
        await this.auditService.record(
          {
            tenantId,
            action: 'cash_movement.sale_backfill',
            entityType: 'shift',
            entityId: shift.id,
            metadata: { count: added.length },
          },
          manager,
        );
      }
    });
    const movements = await this.movementRepository.find({
      where: { tenantId, shiftId: shift.id },
      relations: { user: true },
      order: { createdAt: 'ASC' },
    });
    const entries = movements.map((m) => ({
      ...this.movementView(m),
      direction: movementDirection(m.type),
      inExpectedCash: !LEDGER_ONLY_TYPES.includes(m.type),
    }));
    const sales = entries.filter((e) => e.type === CashMovementType.SALE);
    return {
      shiftId: shift.id,
      shiftNumber: shift.shiftNumber,
      currencyCode: shift.currencyCode,
      entries,
      cashSalesTotal: round2(sales.reduce((sum, e) => sum + e.amount, 0)),
      saleCount: sales.length,
      noSaleCount: entries.filter((e) => e.type === CashMovementType.NO_SALE)
        .length,
    };
  }

  /** Start counting the drawer. Selling on this register should stop. */
  async startClose(
    tenantId: string,
    user: AuthUser,
    shiftId: string,
    dto: StartCloseDto,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const shift = await this.lockShift(manager, tenantId, shiftId);
      this.assertCanOperate(user, shift);
      if (shift.status === ShiftStatus.CLOSED) {
        throw new ConflictException('This shift is already closed');
      }
      if (shift.status === ShiftStatus.CLOSING) return;
      shift.status = ShiftStatus.CLOSING;
      shift.blindCount = dto.blind ?? false;
      shift.closingStartedAt = new Date();
      await manager.getRepository(Shift).save(shift);
      await this.auditService.record(
        {
          tenantId,
          action: 'shift.closing_started',
          entityType: 'shift',
          entityId: shift.id,
          metadata: { blind: shift.blindCount },
        },
        manager,
      );
    });
    return this.findOne(tenantId, user, shiftId);
  }

  /** Back to selling (e.g. the count was started by mistake) */
  async resume(tenantId: string, user: AuthUser, shiftId: string) {
    await this.dataSource.transaction(async (manager) => {
      const shift = await this.lockShift(manager, tenantId, shiftId);
      this.assertCanOperate(user, shift);
      if (shift.status !== ShiftStatus.CLOSING) {
        throw new ConflictException('This shift is not being closed');
      }
      shift.status = ShiftStatus.OPEN;
      shift.closingStartedAt = null;
      shift.blindCount = false;
      await manager.getRepository(Shift).save(shift);
      await this.auditService.record(
        {
          tenantId,
          action: 'shift.closing_cancelled',
          entityType: 'shift',
          entityId: shift.id,
        },
        manager,
      );
    });
    return this.findOne(tenantId, user, shiftId);
  }

  /**
   * Review step: counted vs expected and what closing will need. Saves nothing.
   */
  async previewClose(
    tenantId: string,
    user: AuthUser,
    shiftId: string,
    dto: CountDto,
  ) {
    const shift = await this.getShift(tenantId, shiftId);
    this.assertCanOperate(user, shift, true);
    if (shift.status === ShiftStatus.CLOSED) {
      throw new ConflictException('This shift is already closed');
    }
    const counted = this.countedFrom(dto);
    const breakdown = await this.computeBreakdown(
      this.dataSource.manager,
      shift,
    );
    const settings = await this.settingsService.getSettings(tenantId);
    const result = evaluateVariance(
      counted,
      expectedCash(breakdown),
      settings.shiftVarianceTolerance,
    );
    const foreign = evaluateForeignCash(
      breakdown.foreign,
      dto.foreignCounts,
      this.rateOf(settings, shift.currencyCode),
      settings.shiftVarianceTolerance,
    );
    const overTolerance =
      result.overTolerance || foreign.some((f) => f.overTolerance);
    const canManage = can(user, 'shifts.manage');
    return {
      ...result,
      foreign,
      breakdown,
      requiresReason: overTolerance,
      requiresApproval:
        !canManage && (overTolerance || shift.openedById !== user.id),
    };
  }

  /**
   * Close with a counted drawer. Idempotent: the shift row is locked, and a
   * retry with the same idempotency key returns the first result unchanged.
   */
  async close(
    tenantId: string,
    user: AuthUser,
    shiftId: string,
    dto: CloseShiftDto,
    approvalToken?: string,
  ) {
    const context = await this.closeContext(tenantId, user, approvalToken);
    let replayed = false;
    try {
      await this.dataSource.transaction(async (manager) => {
        ({ replayed } = await this.closeLocked(
          manager,
          tenantId,
          user,
          shiftId,
          dto,
          context,
        ));
      });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, 'uq_shift_close_idempotency')) {
        throw new ConflictException(
          'This idempotency key was already used to close another shift',
        );
      }
      throw error;
    }

    const shift = await this.findOne(tenantId, user, shiftId);
    return { ...shift, replayed };
  }

  /**
   * Handover: close with the counted drawer and, in the same transaction, open
   * the drawer's next shift for the incoming cashier with the counted cash as
   * its opening float. Idempotent like close.
   */
  async handover(
    tenantId: string,
    user: AuthUser,
    shiftId: string,
    dto: HandoverShiftDto,
    approvalToken?: string,
  ) {
    if (dto.handToUserId === user.id) {
      throw new BadRequestException('Hand the drawer over to another cashier');
    }
    const [member] = await this.dataSource.query<{ id: string }[]>(
      `SELECT u.id FROM tenant_memberships m JOIN users u ON u.id = m."userId"
       WHERE m."tenantId" = $1 AND m."userId" = $2 AND m.status::text = 'active'`,
      [tenantId, dto.handToUserId],
    );
    if (!member) {
      throw new BadRequestException(
        'The incoming cashier is not an active member of the store',
      );
    }
    const context = await this.closeContext(tenantId, user, approvalToken);
    let replayed = false;
    let next: Shift | null = null;
    try {
      await this.dataSource.transaction(async (manager) => {
        const closed = await this.closeLocked(
          manager,
          tenantId,
          user,
          shiftId,
          dto,
          context,
          { handedOverToId: dto.handToUserId },
        );
        replayed = closed.replayed;
        const shift = closed.shift;
        if (replayed) {
          next = await manager
            .getRepository(Shift)
            .findOne({ where: { tenantId, previousShiftId: shift.id } });
          return;
        }
        const register = await manager
          .getRepository(Register)
          .findOneOrFail({ where: { id: shift.registerId, tenantId } });
        const drawer = await manager
          .getRepository(Drawer)
          .findOneOrFail({ where: { id: shift.drawerId, tenantId } });
        const openedAt = new Date();
        const opened = await this.createShift(manager, {
          tenantId,
          register,
          drawer,
          openedById: dto.handToUserId,
          openedAt,
          // The counted drawer carries over as the next float
          openingFloat: round2(Number(shift.countedCash ?? 0)),
          // So does the counted cash in other currencies
          openingForeignCash: (shift.foreignCash ?? [])
            .filter((f) => Number(f.counted) > 0)
            .map((f) => ({
              currencyCode: f.currencyCode,
              amount: round2(Number(f.counted)),
            })),
          denominations: shift.closingDenominations,
          notes: `Handed over from ${shift.shiftNumber}`,
          currencyCode: shift.currencyCode,
          shared: shift.shared,
          businessDate: await this.businessDateFor(
            manager,
            shift.branchId,
            openedAt,
            context.settings,
          ),
          previousShiftId: shift.id,
        });
        next = opened;
        await this.auditService.record(
          {
            tenantId,
            action: 'shift.handed_over',
            entityType: 'shift',
            entityId: shift.id,
            metadata: {
              shiftNumber: shift.shiftNumber,
              nextShiftId: opened.id,
              nextShiftNumber: opened.shiftNumber,
              handedOverToId: dto.handToUserId,
              openingFloat: opened.openingFloat,
              openingForeignCash: opened.openingForeignCash,
            },
          },
          manager,
        );
      });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, 'uq_shift_close_idempotency')) {
        throw new ConflictException(
          'This idempotency key was already used to close another shift',
        );
      }
      throw error;
    }
    const closed = await this.findOne(tenantId, user, shiftId);
    const nextShift = next as Shift | null;
    return {
      ...closed,
      replayed,
      nextShift: nextShift
        ? {
            id: nextShift.id,
            shiftNumber: nextShift.shiftNumber,
            openedById: nextShift.openedById,
            openingFloat: round2(Number(nextShift.openingFloat)),
            openingForeignCash: nextShift.openingForeignCash ?? null,
          }
        : null,
    };
  }

  private async closeContext(
    tenantId: string,
    user: AuthUser,
    approvalToken?: string,
  ) {
    const settings = await this.settingsService.getSettings(tenantId);
    return {
      settings,
      canManage: can(user, 'shifts.manage'),
      // Verified up-front (outside the lock); the token is bound to this user
      tokenApproverId: approvalToken
        ? await this.approvalsService.verify(
            approvalToken,
            'shifts.manage',
            user,
          )
        : null,
    };
  }

  /** The close itself, inside the caller's transaction (close, handover) */
  private async closeLocked(
    manager: EntityManager,
    tenantId: string,
    user: AuthUser,
    shiftId: string,
    dto: CloseShiftDto,
    context: {
      settings: StoreSettings;
      canManage: boolean;
      tokenApproverId: string | null;
    },
    options: { handedOverToId?: string } = {},
  ): Promise<{ replayed: boolean; shift: Shift }> {
    const counted = this.countedFrom(dto);
    const { settings, canManage, tokenApproverId } = context;
    const { shiftVarianceTolerance } = settings;
    const shift = await this.lockShift(manager, tenantId, shiftId);

    if (shift.status === ShiftStatus.CLOSED) {
      if (shift.closeIdempotencyKey === dto.idempotencyKey) {
        return { replayed: true, shift };
      }
      throw new ConflictException('This shift is already closed');
    }

    // Closing someone else's shift is a manager action (a shared shift is everyone's)
    const ownShift = shift.openedById === user.id || !!shift.shared;
    if (!ownShift && !canManage && !tokenApproverId) {
      throw new ForbiddenException({
        message: 'Only a manager can close a shift opened by someone else',
        error: 'Forbidden',
        missingPermissions: ['shifts.manage'],
        approvable: true,
      });
    }

    // Per-sale drawer ledger: record what the sale.completed consumer has not (yet)
    const ledger = await syncSaleCashMovements(manager, {
      tenantId,
      shiftId: shift.id,
    });
    if (ledger.length > 0) {
      await this.auditService.record(
        {
          tenantId,
          action: 'cash_movement.sale_backfill',
          entityType: 'shift',
          entityId: shift.id,
          metadata: { count: ledger.length },
        },
        manager,
      );
    }

    const breakdown = await this.computeBreakdown(manager, shift);
    const result = evaluateVariance(
      counted,
      expectedCash(breakdown),
      shiftVarianceTolerance,
    );
    const foreign = evaluateForeignCash(
      breakdown.foreign,
      dto.foreignCounts,
      this.rateOf(settings, shift.currencyCode),
      shiftVarianceTolerance,
    );
    const authority = checkCloseAuthority({
      overTolerance:
        result.overTolerance || foreign.some((f) => f.overTolerance),
      varianceReason: dto.varianceReason,
      closerCanManage: canManage,
      approverId: tokenApproverId,
      closerId: user.id,
    });
    if (!authority.ok) {
      if (authority.code === 'reason_required') {
        throw new BadRequestException({
          message: authority.message,
          error: 'Bad Request',
          code: authority.code,
          variance: result.variance,
        });
      }
      throw new ForbiddenException({
        message: authority.message,
        error: 'Forbidden',
        code: authority.code,
        missingPermissions: ['shifts.manage'],
        approvable: true,
        variance: result.variance,
      });
    }
    const approverId =
      authority.approverId ?? (!ownShift ? tokenApproverId : null);

    const denominations = dto.denominations?.filter((d) => d.quantity > 0);
    shift.status = ShiftStatus.CLOSED;
    shift.closedAt = new Date();
    shift.closedById = user.id;
    shift.closeApprovedById = canManage ? null : approverId;
    shift.closingDenominations = denominations?.length ? denominations : null;
    shift.countedCash = result.counted;
    shift.expectedCash = result.expected;
    shift.variance = result.variance;
    shift.foreignCash = foreign.length
      ? foreign.map((f) => ({
          currencyCode: f.currencyCode,
          expected: f.expected,
          counted: f.counted,
          variance: f.variance,
          exchangeRate: f.exchangeRate,
        }))
      : null;
    shift.varianceReason = dto.varianceReason?.trim() || null;
    shift.closingNotes = dto.notes?.trim() || null;
    shift.forceClosed = !ownShift;
    shift.closeIdempotencyKey = dto.idempotencyKey;
    if (options.handedOverToId) shift.handedOverToId = options.handedOverToId;
    if (!shift.closingStartedAt) shift.closingStartedAt = shift.closedAt;

    const report = await this.buildZReport(
      manager,
      shift,
      breakdown,
      result,
      foreign,
    );
    shift.closingSummary = report as unknown as Record<string, unknown>;
    await manager.getRepository(Shift).save(shift);

    await this.auditService.record(
      {
        tenantId,
        action: shift.forceClosed ? 'shift.force_closed' : 'shift.closed',
        entityType: 'shift',
        entityId: shift.id,
        reason: shift.varianceReason,
        approverId: shift.closeApprovedById ?? undefined,
        metadata: {
          shiftNumber: shift.shiftNumber,
          expected: result.expected,
          counted: result.counted,
          variance: result.variance,
          overTolerance: result.overTolerance,
        },
      },
      manager,
    );
    await this.outbox?.record(manager, {
      tenantId,
      type: 'shift.closed',
      aggregateId: shift.id,
      aggregateVersion: shift.version ?? null,
      payload: {
        shiftId: shift.id,
        shiftNumber: shift.shiftNumber,
        registerId: shift.registerId,
        expected: result.expected,
        counted: result.counted,
        variance: result.variance,
        tolerance: result.tolerance,
        overTolerance:
          result.overTolerance || foreign.some((f) => f.overTolerance),
        forceClosed: shift.forceClosed,
        closedById: user.id,
      },
    });
    return { replayed: false, shift };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** Current shift for a register, with live totals (for the till) */
  async current(tenantId: string, user: AuthUser, registerId: string) {
    const ref = await this.getOpenShift(tenantId, registerId);
    if (!ref) return { shift: null };
    return { shift: await this.findOne(tenantId, user, ref.id) };
  }

  async list(tenantId: string, user: AuthUser, query: ListShiftsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const qb = this.shiftRepository
      .createQueryBuilder('shift')
      .leftJoin('shift.register', 'register')
      .leftJoin('shift.openedBy', 'openedBy')
      .leftJoin('shift.closedBy', 'closedBy')
      .leftJoin('shift.drawer', 'drawer')
      .addSelect([
        'register.id',
        'register.name',
        'register.code',
        'drawer.id',
        'drawer.code',
        'drawer.name',
        'openedBy.id',
        'openedBy.email',
        'openedBy.firstName',
        'openedBy.lastName',
        'closedBy.id',
        'closedBy.email',
        'closedBy.firstName',
        'closedBy.lastName',
      ])
      .where('shift.tenantId = :tenantId', { tenantId })
      .orderBy('shift.openedAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    // Without shifts.manage you only see your own shifts (and shared ones)
    if (!can(user, 'shifts.manage')) {
      qb.andWhere('(shift.openedById = :me OR shift.shared = true)', {
        me: user.id,
      });
    } else if (query.userId) {
      qb.andWhere('(shift.openedById = :uid OR shift.closedById = :uid)', {
        uid: query.userId,
      });
    }
    if (query.status) {
      qb.andWhere('shift.status = :status', { status: query.status });
    }
    if (query.registerId) {
      qb.andWhere('shift.registerId = :registerId', {
        registerId: query.registerId,
      });
    }
    // Only the shifts of the user's branches (older shifts: their register's)
    const branches = scopedBranchIds(branchScope(user));
    if (branches) {
      qb.andWhere(
        'COALESCE("shift"."branchId", "register"."branchId") = ANY(:shiftBranches)',
        { shiftBranches: branches },
      );
    }
    if (query.from)
      qb.andWhere('shift.openedAt >= :from', { from: query.from });
    if (query.to) qb.andWhere('shift.openedAt <= :to', { to: query.to });
    if (query.varianceOnly === 'true') {
      const { shiftVarianceTolerance } =
        await this.settingsService.getSettings(tenantId);
      qb.andWhere('ABS(shift.variance) > :tol', {
        tol: shiftVarianceTolerance,
      });
    }

    const [rows, total] = await qb.getManyAndCount();
    const { shiftVarianceTolerance } =
      await this.settingsService.getSettings(tenantId);
    const lateCounts = await this.lateSalesCounts(
      this.dataSource.manager,
      tenantId,
      rows,
    );
    return paginate(
      rows.map((shift) => ({
        ...this.shiftView(shift, user),
        lateSalesCount: lateCounts.get(shift.id) ?? 0,
        overTolerance:
          shift.variance !== null &&
          evaluateVariance(shift.variance, 0, shiftVarianceTolerance)
            .overTolerance,
      })),
      total,
      page,
      limit,
    );
  }

  async findOne(tenantId: string, user: AuthUser, id: string) {
    const shift = await this.shiftRepository.findOne({
      where: { id, tenantId },
      relations: {
        register: true,
        drawer: true,
        openedBy: true,
        closedBy: true,
      },
    });
    if (!shift) throw new NotFoundException('Shift not found');
    await this.assertShiftBranch(this.dataSource.manager, shift);
    this.assertCanView(user, shift);

    const movements = await this.movementRepository.find({
      where: { tenantId, shiftId: id },
      relations: { user: true },
      order: { createdAt: 'ASC' },
    });
    const hideExpected =
      shift.status !== ShiftStatus.CLOSED &&
      shift.blindCount &&
      !can(user, 'shifts.manage');

    let breakdown: (CashBreakdown & { expected: number }) | null = null;
    let sales: ShiftSalesSummary | null = null;
    let lateSales: LateSalesSummary | null = null;
    let corrections: CorrectionsSummary | null = null;
    if (shift.status !== ShiftStatus.CLOSED) {
      const b = await this.computeBreakdown(this.dataSource.manager, shift);
      breakdown = { ...b, expected: expectedCash(b) };
      sales = await this.salesSummary(this.dataSource.manager, shift);
    } else {
      // Closed: the figures frozen at close, plus what was uploaded since
      const frozen = await this.frozenReport(this.dataSource.manager, shift);
      breakdown = frozen.cash;
      sales = frozen.sales;
      lateSales = await this.lateSales(this.dataSource.manager, shift);
      corrections = await this.correctionsSummary(
        this.dataSource.manager,
        shift,
      );
    }

    return {
      ...this.shiftView(shift, user),
      openingDenominations: shift.openingDenominations,
      closingDenominations: shift.closingDenominations,
      openingNotes: shift.openingNotes,
      closingNotes: shift.closingNotes,
      closeApprovedById: shift.closeApprovedById,
      cash: hideExpected ? null : breakdown,
      sales: hideExpected ? null : sales,
      lateSales,
      corrections,
      movements: movements.map((m) => this.movementView(m)),
    };
  }

  /** Z-report: the frozen one for closed shifts, a live X-report otherwise */
  async zReport(
    tenantId: string,
    user: AuthUser,
    id: string,
  ): Promise<ZReport> {
    const shift = await this.getShift(tenantId, id);
    this.assertCanView(user, shift);
    if (shift.status === ShiftStatus.CLOSED) {
      const manager = this.dataSource.manager;
      return {
        ...(await this.frozenReport(manager, shift)),
        lateSales: await this.lateSales(manager, shift),
        corrections: await this.correctionsSummary(manager, shift),
      };
    }
    if (shift.blindCount && !can(user, 'shifts.manage')) {
      throw new ForbiddenException(
        'The expected cash is hidden until the blind count is submitted',
      );
    }
    const breakdown = await this.computeBreakdown(
      this.dataSource.manager,
      shift,
    );
    return this.buildZReport(this.dataSource.manager, shift, breakdown, null);
  }

  // ---------------------------------------------------------------------------
  // Denominations
  // ---------------------------------------------------------------------------

  async getDenominations(tenantId: string, currencyCode?: string) {
    const currency = (
      currencyCode ??
      (await this.settingsService.getSettings(tenantId)).currencyCode
    ).toUpperCase();
    const custom = await this.denominationRepository.findOne({
      where: { tenantId, currencyCode: currency },
    });
    return {
      currencyCode: currency,
      denominations: custom?.denominations ?? defaultDenominations(currency),
      custom: !!custom,
      defaults: defaultDenominations(currency),
    };
  }

  async setDenominations(tenantId: string, dto: SetDenominationsDto) {
    const currencyCode = dto.currencyCode.toUpperCase();
    const before = await this.getDenominations(tenantId, currencyCode);
    if (dto.denominations.length === 0) {
      await this.denominationRepository.delete({ tenantId, currencyCode });
    } else {
      const denominations = normalizeDenominations(dto.denominations);
      await this.denominationRepository.upsert(
        { tenantId, currencyCode, denominations },
        ['tenantId', 'currencyCode'],
      );
    }
    const after = await this.getDenominations(tenantId, currencyCode);
    await this.auditService.record({
      tenantId,
      action: 'cash_denominations.updated',
      entityType: 'cash_denominations',
      entityId: currencyCode,
      changes: { before: before.denominations, after: after.denominations },
    });
    return after;
  }

  // ---------------------------------------------------------------------------
  // Cash math against the database
  // ---------------------------------------------------------------------------

  /**
   * Everything that moved cash in or out of the drawer during the shift. For a
   * closed shift only sales recorded before the close count (see saleScope).
   */
  async computeBreakdown(
    manager: EntityManager,
    shift: Shift,
  ): Promise<CashBreakdown> {
    const { where, params } = await this.saleScope(manager, shift);
    const { cash, foreign } = await this.saleCash(manager, where, params);

    const movements = await manager.query<
      { type: CashMovementType; total: string | number }[]
    >(
      // 'sale' / 'no_sale' rows are the drawer's trace: cash sales come from payments.
      // Movements in another currency count in that currency's drawer, below
      `SELECT type, COALESCE(SUM(amount), 0) AS total FROM cash_movements
       WHERE "tenantId" = $1 AND "shiftId" = $2 AND NOT (type::text = ANY($3))
         AND "currencyCode" IS NULL
       GROUP BY type`,
      [shift.tenantId, shift.id, LEDGER_ONLY_TYPES],
    );
    const sum = (type: CashMovementType) =>
      round2(Number(movements.find((m) => m.type === type)?.total ?? 0));
    const foreignMovements = await manager.query<
      { currencyCode: string; type: CashMovementType; total: string | number }[]
    >(
      `SELECT "currencyCode", type, COALESCE(SUM(amount), 0) AS total FROM cash_movements
       WHERE "tenantId" = $1 AND "shiftId" = $2 AND NOT (type::text = ANY($3))
         AND "currencyCode" IS NOT NULL
       GROUP BY "currencyCode", type`,
      [shift.tenantId, shift.id, LEDGER_ONLY_TYPES],
    );

    return {
      openingFloat: round2(Number(shift.openingFloat)),
      cashSales: cash.tendered,
      changeGiven: cash.change,
      paidIn: sum(CashMovementType.PAID_IN),
      paidOut: sum(CashMovementType.PAID_OUT),
      safeDrops: sum(CashMovementType.SAFE_DROP),
      expensePayouts: sum(CashMovementType.EXPENSE),
      cashRefunds: sum(CashMovementType.REFUND),
      foreign: withOpeningForeign(
        foreign,
        shift.openingForeignCash,
        foreignMovements.map((m) => ({
          currencyCode: m.currencyCode,
          type: m.type,
          amount: Number(m.total),
        })),
      ),
    };
  }

  /**
   * Cash the given sales put in the drawer: tendered and change in the sale
   * currency, and per other currency (tendered and handed back in that currency)
   */
  private async saleCash(
    manager: EntityManager,
    where: string,
    params: unknown[],
  ) {
    const [cash] = await manager.query<
      { tendered: string | number | null; change: string | number | null }[]
    >(
      `WITH scoped AS (
         SELECT s.id, s."changeAmount", s.metadata FROM sales s WHERE ${where}
       ), tendered AS (
         SELECT COALESCE(SUM(p.amount), 0) AS amount
         FROM payments p
         JOIN scoped ON scoped.id = p."saleId"
         JOIN payment_methods pm ON pm.id = p."paymentMethodId"
         WHERE p."tenantId" = $1 AND pm."methodType" = 'cash'
           AND p."tenderedCurrency" IS NULL
           AND p.status::text = ANY($${params.length + 1})
       )
       SELECT (SELECT amount FROM tendered) AS tendered,
              -- Change is only ever given from cash; here, what was given in the sale currency
              (SELECT COALESCE(SUM("changeAmount"), 0) FROM scoped
               WHERE metadata->'changeTender' IS NULL
                  OR jsonb_typeof(metadata->'changeTender') = 'null') AS change`,
      [...params, COUNTED_PAYMENT_STATUSES],
    );

    const foreignRows = await manager.query<
      { currency: string; tendered: string | number; change: string | number }[]
    >(
      `WITH scoped AS (
         SELECT s.id, s.metadata FROM sales s WHERE ${where}
       ), tendered AS (
         SELECT p."tenderedCurrency" AS currency, SUM(p."tenderedAmount") AS amount
         FROM payments p
         JOIN scoped ON scoped.id = p."saleId"
         JOIN payment_methods pm ON pm.id = p."paymentMethodId"
         WHERE p."tenantId" = $1 AND pm."methodType" = 'cash'
           AND p."tenderedCurrency" IS NOT NULL
           AND p.status::text = ANY($${params.length + 1})
         GROUP BY 1
       ), change AS (
         SELECT metadata->'changeTender'->>'currencyCode' AS currency,
                SUM((metadata->'changeTender'->>'amount')::numeric) AS amount
         FROM scoped
         WHERE jsonb_typeof(metadata->'changeTender') = 'object'
         GROUP BY 1
       )
       SELECT COALESCE(t.currency, c.currency) AS currency,
              COALESCE(t.amount, 0) AS tendered, COALESCE(c.amount, 0) AS change
       FROM tendered t FULL JOIN change c ON c.currency = t.currency
       ORDER BY 1`,
      [...params, COUNTED_PAYMENT_STATUSES],
    );
    const foreign = foreignRows.map((row) => {
      const cashSales = round2(Number(row.tendered));
      const changeGiven = round2(Number(row.change));
      return {
        currencyCode: row.currency.trim(),
        cashSales,
        changeGiven,
        expected: round2(cashSales - changeGiven),
      };
    });
    return {
      cash: {
        tendered: round2(Number(cash?.tendered ?? 0)),
        change: round2(Number(cash?.change ?? 0)),
      },
      foreign,
    };
  }

  /**
   * A closed shift's report as frozen at close. Shifts closed before the summary
   * was stored are rebuilt from the sales recorded before the close and the
   * stored count, so later uploads never change them either.
   */
  private async frozenReport(
    manager: EntityManager,
    shift: Shift,
  ): Promise<ZReport> {
    if (shift.closingSummary) {
      return shift.closingSummary as unknown as ZReport;
    }
    const breakdown = await this.computeBreakdown(manager, shift);
    const { shiftVarianceTolerance } = await this.settingsService.getSettings(
      shift.tenantId,
    );
    const expected =
      shift.expectedCash !== null && shift.expectedCash !== undefined
        ? Number(shift.expectedCash)
        : expectedCash(breakdown);
    const result =
      shift.countedCash !== null && shift.countedCash !== undefined
        ? evaluateVariance(
            Number(shift.countedCash),
            expected,
            shiftVarianceTolerance,
          )
        : null;
    const report = await this.buildZReport(manager, shift, breakdown, result);
    return { ...report, cash: { ...report.cash, expected } };
  }

  /**
   * Sales uploaded after the shift closed (null while it is open). They are not
   * in the frozen figures: shown as a supplement for a manager to review.
   */
  async lateSales(
    manager: EntityManager,
    shift: Shift,
  ): Promise<LateSalesSummary | null> {
    if (shift.status !== ShiftStatus.CLOSED || !shift.closedAt) return null;
    const { lateWhere, params } = await this.saleScope(manager, shift);
    if (!lateWhere) return null;
    const byCurrency = await manager.query<
      { currencyCode: string; count: string | number; total: string | number }[]
    >(
      `SELECT TRIM(s."currencyCode") AS "currencyCode", COUNT(*) AS count,
              COALESCE(SUM(s.total), 0) AS total
       FROM sales s WHERE ${lateWhere} GROUP BY 1 ORDER BY 1`,
      params,
    );
    const count = byCurrency.reduce((sum, row) => sum + Number(row.count), 0);
    if (count === 0) {
      return { count: 0, byCurrency: [], cash: 0, foreignCash: [], sales: [] };
    }
    const { cash, foreign } = await this.saleCash(manager, lateWhere, params);
    const rows = await manager.query<
      {
        id: string;
        saleNumber: string;
        saleDate: Date | string;
        uploadedAt: Date | string;
        total: string | number;
        currencyCode: string;
      }[]
    >(
      `SELECT s.id, s."saleNumber", s."saleDate", s.created_at AS "uploadedAt", s.total,
              TRIM(s."currencyCode") AS "currencyCode"
       FROM sales s WHERE ${lateWhere}
       ORDER BY s.created_at LIMIT ${LATE_SALES_LISTED}`,
      params,
    );
    return {
      count,
      byCurrency: byCurrency.map((row) => ({
        currencyCode: row.currencyCode,
        count: Number(row.count),
        total: round2(Number(row.total)),
      })),
      cash: round2(cash.tendered - cash.change),
      foreignCash: foreign
        .map((f) => ({ currencyCode: f.currencyCode, amount: f.expected }))
        .filter((f) => f.amount !== 0),
      sales: rows.map((row) => ({
        id: row.id,
        saleNumber: row.saleNumber,
        saleDate: new Date(row.saleDate).toISOString(),
        uploadedAt: new Date(row.uploadedAt).toISOString(),
        total: round2(Number(row.total)),
        currencyCode: row.currencyCode,
      })),
    };
  }

  /** Corrections of a closed shift with the corrected figures (null: none) */
  async correctionsSummary(
    manager: EntityManager,
    shift: Shift,
  ): Promise<CorrectionsSummary | null> {
    if (shift.status !== ShiftStatus.CLOSED) return null;
    const rows = (
      await manager.query<
        {
          id: string;
          type: string;
          amount: string | number;
          reason: string;
          createdAt: Date | string;
          createdById: string;
          approvedById: string;
        }[]
      >(
        `SELECT c.id, c.type, c.amount, c.reason, c.created_at AS "createdAt",
                c."createdById", c."approvedById"
         FROM shift_corrections c
         WHERE c."tenantId" = $1 AND c."shiftId" = $2
         ORDER BY c.created_at`,
        [shift.tenantId, shift.id],
      )
    ).filter((row) =>
      (Object.values(ShiftCorrectionType) as string[]).includes(row.type),
    );
    if (rows.length === 0) return null;
    const names = await this.userNames(
      manager,
      rows.flatMap((row) => [row.createdById, row.approvedById]),
    );
    return summarizeCorrections(
      rows.map((row) => ({
        id: row.id,
        type: row.type as ShiftCorrectionType,
        amount: round2(Number(row.amount)),
        reason: row.reason,
        createdAt: new Date(row.createdAt).toISOString(),
        createdBy: names.get(row.createdById) ?? null,
        approvedBy: names.get(row.approvedById) ?? null,
      })),
      shift.expectedCash,
      shift.countedCash,
    );
  }

  /** Number of late uploads per closed shift, for the shift list */
  private async lateSalesCounts(
    manager: EntityManager,
    tenantId: string,
    shifts: Shift[],
  ): Promise<Map<string, number>> {
    const closed = shifts.filter(
      (sh) => sh.status === ShiftStatus.CLOSED && sh.closedAt,
    );
    if (closed.length === 0 || !(await this.hasSalesShiftColumn(manager))) {
      return new Map();
    }
    const statuses = COUNTED_SALE_STATUSES.map((st) => `'${st}'`).join(', ');
    const rows = await manager.query<{ id: string; count: string | number }[]>(
      `SELECT sh.id, COUNT(s.id) AS count
       FROM shifts sh
       JOIN sales s ON s."tenantId" = sh."tenantId" AND s."registerId" = sh."registerId"
        AND s.created_at > sh."closedAt" AND s.status::text IN (${statuses})
        AND (s."shiftId" = sh.id
             OR (s."shiftId" IS NULL AND s."saleDate" >= sh."openedAt" AND s."saleDate" <= sh."closedAt"))
       WHERE sh."tenantId" = $1 AND sh.id = ANY($2)
       GROUP BY sh.id`,
      [tenantId, closed.map((sh) => sh.id)],
    );
    return new Map(rows.map((row) => [row.id, Number(row.count)]));
  }

  private async salesSummary(
    manager: EntityManager,
    shift: Shift,
  ): Promise<ShiftSalesSummary> {
    const { where, params, voidedWhere } = await this.saleScope(manager, shift);
    const [totals] = await manager.query<
      { count: string; total: string | null }[]
    >(
      `SELECT COUNT(*) AS count, COALESCE(SUM(s.total), 0) AS total FROM sales s WHERE ${where}`,
      params,
    );
    const [voided] = await manager.query<
      { count: string; total: string | null }[]
    >(
      `SELECT COUNT(*) AS count, COALESCE(SUM(s.total), 0) AS total FROM sales s WHERE ${voidedWhere}`,
      params,
    );
    const byMethod = await manager.query<
      {
        id: string;
        name: string | null;
        code: string;
        methodType: string;
        count: string;
        amount: string | number;
      }[]
    >(
      `SELECT pm.id, pm.name->>'en' AS name, pm.code, pm."methodType",
              COUNT(DISTINCT p."saleId") AS count, COALESCE(SUM(p.amount), 0) AS amount
       FROM payments p
       JOIN sales s ON s.id = p."saleId"
       JOIN payment_methods pm ON pm.id = p."paymentMethodId"
       WHERE ${where} AND p.status::text = ANY($${params.length + 1})
       GROUP BY pm.id, pm.name, pm.code, pm."methodType"
       ORDER BY amount DESC`,
      [...params, COUNTED_PAYMENT_STATUSES],
    );
    return {
      count: Number(totals?.count ?? 0),
      total: round2(Number(totals?.total ?? 0)),
      voidedCount: Number(voided?.count ?? 0),
      voidedTotal: round2(Number(voided?.total ?? 0)),
      byPaymentMethod: byMethod.map((row) => ({
        paymentMethodId: row.id,
        name: row.name ?? row.code,
        methodType: row.methodType,
        count: Number(row.count),
        amount: round2(Number(row.amount)),
      })),
    };
  }

  /**
   * SQL filter for the shift's sales: stamped with this shift id, or (for
   * sales without one) made on the register during the shift's time window.
   * Works before and after the sales module added sales.shiftId.
   *
   * A closed shift is frozen: only sales recorded (created) up to the close
   * belong to its figures. Sales recorded later — offline sales uploaded after
   * the close, with a capture time inside the shift — are `lateWhere`.
   */
  private async saleScope(manager: EntityManager, shift: Shift) {
    const hasShiftId = await this.hasSalesShiftColumn(manager);
    const closedAt =
      shift.status === ShiftStatus.CLOSED && shift.closedAt
        ? shift.closedAt
        : null;
    const params: unknown[] = [
      shift.tenantId,
      shift.registerId,
      shift.openedAt,
      closedAt ?? shift.closedAt ?? new Date(),
    ];
    const window = `s."saleDate" >= $3 AND s."saleDate" <= $4`;
    let scope: string;
    if (hasShiftId) {
      params.push(shift.id);
      scope = `(s."shiftId" = $5 OR (s."shiftId" IS NULL AND ${window}))`;
    } else {
      scope = `(${window})`;
    }
    const base = `s."tenantId" = $1 AND s."registerId" = $2 AND ${scope}`;
    // $4 is the close time for a closed shift
    const recorded = closedAt ? ` AND s.created_at <= $4` : '';
    const statuses = COUNTED_SALE_STATUSES.map((s) => `'${s}'`).join(', ');
    return {
      params,
      where: `${base}${recorded} AND s.status::text IN (${statuses})`,
      voidedWhere: `${base}${recorded} AND s.status::text = 'voided'`,
      lateWhere: closedAt
        ? `${base} AND s.created_at > $4 AND s.status::text IN (${statuses})`
        : null,
    };
  }

  private async hasSalesShiftColumn(manager: EntityManager) {
    const cached = this.salesShiftColumn;
    if (cached && (cached.exists || Date.now() - cached.checkedAt < 60_000)) {
      return cached.exists;
    }
    const rows = await manager.query<unknown[]>(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'sales' AND column_name = 'shiftId'`,
    );
    this.salesShiftColumn = { exists: rows.length > 0, checkedAt: Date.now() };
    return rows.length > 0;
  }

  private async buildZReport(
    manager: EntityManager,
    shift: Shift,
    breakdown: CashBreakdown,
    result: VarianceResult | null,
    foreignCount: ForeignCashResult[] | null = null,
  ): Promise<ZReport> {
    const sales = await this.salesSummary(manager, shift);
    const movements = await manager.getRepository(CashMovement).find({
      where: { tenantId: shift.tenantId, shiftId: shift.id },
      relations: { user: true },
      order: { createdAt: 'ASC' },
    });
    const register =
      shift.register ??
      (await manager
        .getRepository(Register)
        .findOne({ where: { id: shift.registerId } }));
    const names = await this.userNames(manager, [
      shift.openedById,
      shift.closedById,
      shift.closeApprovedById,
    ]);
    const { shiftVarianceTolerance } = await this.settingsService.getSettings(
      shift.tenantId,
    );

    return {
      generatedAt: new Date().toISOString(),
      final: shift.status === ShiftStatus.CLOSED,
      shift: {
        id: shift.id,
        shiftNumber: shift.shiftNumber,
        status: shift.status,
        registerId: shift.registerId,
        registerName: register?.name ?? null,
        currencyCode: shift.currencyCode,
        openedAt: new Date(shift.openedAt).toISOString(),
        openedBy: names.get(shift.openedById) ?? null,
        closedAt: shift.closedAt
          ? new Date(shift.closedAt).toISOString()
          : null,
        closedBy: shift.closedById
          ? (names.get(shift.closedById) ?? null)
          : null,
        approvedBy: shift.closeApprovedById
          ? (names.get(shift.closeApprovedById) ?? null)
          : null,
        blindCount: shift.blindCount,
        forceClosed: shift.forceClosed,
        businessDate: shift.businessDate ?? null,
      },
      sales,
      cash: { ...breakdown, expected: expectedCash(breakdown) },
      // Per-sale rows are in the drawer ledger, not the report
      movements: movements
        .filter((m) => m.type !== CashMovementType.SALE)
        .map((m) => ({
          id: m.id,
          type: m.type,
          amount: round2(Number(m.amount)),
          currencyCode: m.currencyCode ?? null,
          reason: m.reason,
          reference: m.reference,
          createdAt: new Date(m.createdAt).toISOString(),
          user: m.user ? displayName(m.user) : null,
        })),
      count: {
        denominations: shift.closingDenominations,
        counted: result?.counted ?? null,
      },
      variance: {
        expected: result?.expected ?? null,
        counted: result?.counted ?? null,
        variance: result?.variance ?? null,
        tolerance: result?.tolerance ?? shiftVarianceTolerance,
        overTolerance: result?.overTolerance ?? false,
        reason: shift.varianceReason,
      },
      foreignCount,
      notes: shift.closingNotes,
      lateSales: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Units of each currency per 1 unit of the shift's currency */
  private rateOf(settings: StoreSettings, shiftCurrency: string) {
    return (code: string) =>
      exchangeRate(
        settings.exchangeRates,
        settings.currencyCode,
        shiftCurrency,
        code,
      );
  }

  private countedFrom(dto: CountDto): number {
    const denominations = dto.denominations?.filter((d) => d.quantity > 0);
    if (denominations?.length) {
      const total = countTotal(denominations);
      if (dto.countedCash !== undefined && round2(dto.countedCash) !== total) {
        throw new BadRequestException(
          'The counted cash does not match the denomination count',
        );
      }
      return total;
    }
    if (dto.countedCash === undefined) {
      if (dto.denominations) return 0; // all quantities zero: an empty drawer
      throw new BadRequestException(
        'Enter the denomination count or the counted cash total',
      );
    }
    return round2(dto.countedCash);
  }

  private async getShift(tenantId: string, id: string) {
    const shift = await this.shiftRepository.findOne({
      where: { id, tenantId },
    });
    if (!shift) throw new NotFoundException('Shift not found');
    await this.assertShiftBranch(this.dataSource.manager, shift);
    return shift;
  }

  /** Another branch's shift is "not found" for a branch-limited user (spec §9) */
  private async assertShiftBranch(manager: EntityManager, shift: Shift) {
    if (hasAllBranches()) return;
    const branchId =
      shift.branchId ??
      shift.register?.branchId ??
      (await registerBranchId(manager, shift.tenantId, shift.registerId));
    assertBranchAccess(null, branchId, 'Shift not found');
  }

  private async lockShift(
    manager: EntityManager,
    tenantId: string,
    id: string,
  ) {
    const shift = await manager.getRepository(Shift).findOne({
      where: { id, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    if (!shift) throw new NotFoundException('Shift not found');
    await this.assertShiftBranch(manager, shift);
    return shift;
  }

  private async findDuplicateMovement(
    manager: EntityManager,
    input: RecordCashMovementInput,
  ) {
    const repo = manager.getRepository(CashMovement);
    if (input.expenseId) {
      const row = await repo.findOne({ where: { expenseId: input.expenseId } });
      if (row) return row;
    }
    if (input.sourceId && input.sourceType) {
      const row = await repo.findOne({
        where: {
          tenantId: input.tenantId,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
        },
      });
      if (row) return row;
    }
    if (input.idempotencyKey) {
      const row = await repo.findOne({
        where: {
          tenantId: input.tenantId,
          idempotencyKey: input.idempotencyKey,
        },
      });
      if (row) {
        if (row.shiftId !== input.shiftId || row.type !== input.type) {
          throw new ConflictException(
            'This idempotency key was already used for another cash movement',
          );
        }
        return row;
      }
    }
    return null;
  }

  private assertCanView(user: AuthUser, shift: Shift) {
    if (
      can(user, 'shifts.manage') ||
      shift.openedById === user.id ||
      shift.shared
    )
      return;
    throw new ForbiddenException('You can only view your own shifts');
  }

  // Own shift with shifts.operate, anyone's with shifts.manage
  private assertCanOperate(
    user: AuthUser,
    shift: Shift,
    allowApproval = false,
  ) {
    // A shared drawer's shift is run by every cashier on it
    if (
      can(user, 'shifts.manage') ||
      shift.openedById === user.id ||
      shift.shared
    )
      return;
    if (allowApproval) return; // preview: closing will ask for an approval
    throw new ForbiddenException({
      message: 'This shift was opened by someone else',
      error: 'Forbidden',
      missingPermissions: ['shifts.manage'],
      approvable: false,
    });
  }

  private async userNames(manager: EntityManager, ids: (string | null)[]) {
    const unique = [...new Set(ids.filter(Boolean))] as string[];
    const rows = unique.length
      ? await manager.query<
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

  private shiftView(shift: Shift, user: AuthUser) {
    const hideExpected =
      shift.status !== ShiftStatus.CLOSED &&
      shift.blindCount &&
      !can(user, 'shifts.manage');
    return {
      id: shift.id,
      shiftNumber: shift.shiftNumber,
      status: shift.status,
      registerId: shift.registerId,
      registerName: shift.register?.name ?? null,
      drawerId: shift.drawerId ?? null,
      drawerName: shift.drawer?.name ?? null,
      shared: !!shift.shared,
      businessDate: shift.businessDate ?? null,
      previousShiftId: shift.previousShiftId ?? null,
      handedOverToId: shift.handedOverToId ?? null,
      branchId: shift.branchId,
      currencyCode: shift.currencyCode,
      openedById: shift.openedById,
      openedByName: shift.openedBy ? displayName(shift.openedBy) : null,
      openedAt: shift.openedAt,
      openingFloat: round2(Number(shift.openingFloat)),
      openingForeignCash: shift.openingForeignCash ?? null,
      blindCount: shift.blindCount,
      closingStartedAt: shift.closingStartedAt,
      closedById: shift.closedById,
      closedByName: shift.closedBy ? displayName(shift.closedBy) : null,
      closedAt: shift.closedAt,
      countedCash: shift.countedCash,
      expectedCash: hideExpected ? null : shift.expectedCash,
      variance: shift.variance,
      varianceReason: shift.varianceReason,
      forceClosed: shift.forceClosed,
      foreignCash: shift.foreignCash,
    };
  }

  private movementView(m: CashMovement) {
    return {
      id: m.id,
      shiftId: m.shiftId,
      type: m.type,
      amount: round2(Number(m.amount)),
      // null = the shift's currency
      currencyCode: m.currencyCode ?? null,
      reason: m.reason,
      reference: m.reference,
      expenseId: m.expenseId,
      sourceType: m.sourceType,
      sourceId: m.sourceId,
      userId: m.userId,
      userName: m.user ? displayName(m.user) : null,
      approverId: m.approverId,
      createdAt: m.createdAt,
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

/** Which way a movement moves cash (none: no-sale drawer opening) */
export function movementDirection(
  type: CashMovementType,
): 'in' | 'out' | 'none' {
  switch (type) {
    case CashMovementType.OPENING_FLOAT:
    case CashMovementType.PAID_IN:
    case CashMovementType.SALE:
      return 'in';
    case CashMovementType.NO_SALE:
      return 'none';
    default:
      return 'out';
  }
}

/**
 * Corrected close figures: expected + Σ expected corrections, counted + Σ
 * counted corrections, and the variance between them
 */
export function summarizeCorrections(
  corrections: CorrectionsSummary['corrections'],
  expectedCash: number | string | null,
  countedCash: number | string | null,
): CorrectionsSummary {
  const total = (type: ShiftCorrectionType) =>
    round2(
      corrections
        .filter((c) => c.type === type)
        .reduce((sum, c) => sum + c.amount, 0),
    );
  const expectedAdjustment = total(ShiftCorrectionType.EXPECTED);
  const countedAdjustment = total(ShiftCorrectionType.COUNTED);
  const expected =
    expectedCash === null || expectedCash === undefined
      ? null
      : round2(Number(expectedCash) + expectedAdjustment);
  const counted =
    countedCash === null || countedCash === undefined
      ? null
      : round2(Number(countedCash) + countedAdjustment);
  return {
    corrections,
    expectedAdjustment,
    countedAdjustment,
    expected,
    counted,
    variance:
      expected !== null && counted !== null ? round2(counted - expected) : null,
  };
}
