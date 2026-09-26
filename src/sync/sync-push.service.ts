import {
  NotFoundException,
  HttpException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { assertRegisterAccess } from '../auth/branch-scope';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { Sale } from '../database/entities/sale.entity';
import {
  MembershipStatus,
  TenantMembership,
} from '../database/entities/tenant-membership.entity';
import { TenantRole } from '../database/entities/tenant-role.entity';
import { UserStatus } from '../database/entities/user.entity';
import { resolvePermissions } from '../roles/role-permissions';
import {
  ConflictCase,
  ConflictCaseType,
} from '../database/entities/conflict-case.entity';
import { SaleCreateOptions, SalesService } from '../sales/sales.service';
import { openConflictCase } from '../sales/conflict-cases.service';
import { CreateSaleDto } from '../sales/sales.dto';
import { AuditService } from '../audit/audit.service';
import { offlineSyncEventsTotal } from '../metrics/metrics.registry';
import {
  assessOfflineSale,
  CLOCK_TOLERANCE_MS,
  getOfflineLeaseSecret,
  LeaseIssue,
  LeaseVerification,
  verifyLease,
} from './offline-lease';
import { payloadHash } from './payload-hash';
import { SyncOperation, SyncOperationStatus } from './sync-operation.entity';
import {
  SUPPORTED_SCHEMA_VERSION,
  SyncOperationDto,
  SyncPushDto,
} from './sync.dto';

export type SyncAckStatus =
  'accepted' | 'already_applied' | 'pending_dependency' | 'needs_review';

/** Per-operation acknowledgement returned by POST /sync/push. */
export interface SyncAck {
  deviceOperationId: string;
  deviceSequence: number;
  status: SyncAckStatus;
  saleId?: string;
  saleNumber?: string;
  // needs_review / pending_dependency: why; accepted: null
  reason?: string | null;
  // Accepted but outside the till's lease: the review case opened for it
  leaseIssues?: LeaseIssue[];
  conflictCaseId?: string | null;
}

export interface SyncPushResult {
  serverTime: string;
  results: SyncAck[];
}

interface PushOptions {
  // Import of an export file by an administrator (dead till)
  importedBy?: string;
}

type ActingUser = NonNullable<SaleCreateOptions['actingUser']>;

const flatten = (errors: ValidationError[], prefix = ''): string[] =>
  errors.flatMap((e) => [
    ...Object.values(e.constraints ?? {}).map((m) =>
      prefix ? `${prefix}.${m}` : m,
    ),
    ...flatten(
      e.children ?? [],
      prefix ? `${prefix}.${e.property}` : e.property,
    ),
  ]);

const messageOf = (error: HttpException) => {
  const body = error.getResponse() as string | { message?: string | string[] };
  const message = typeof body === 'string' ? body : body?.message;
  return (
    (Array.isArray(message) ? message.join(', ') : message) || error.message
  );
};

/**
 * Batched push of operations recorded on a till (spec §19). Operations are
 * applied in device-sequence order through the same SalesService.create path as
 * POST /sales, each acknowledged on its own:
 * - accepted: applied now (possibly with an offline_lease review case);
 * - already_applied: seen before (resend after a lost acknowledgement);
 * - pending_dependency: not applied yet, retry later (an operation it depends
 *   on is missing, or the server hit a transient error; later operations of
 *   the batch wait too, to keep the device order);
 * - needs_review: the server cannot apply it as is (invalid, rejected); the
 *   till keeps it and shows the reason instead of retrying forever.
 */
@Injectable()
export class SyncPushService {
  private readonly logger = new Logger(SyncPushService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly salesService: SalesService,
    private readonly configService: ConfigService,
    private readonly auditService: AuditService,
  ) {}

  async push(
    tenantId: string,
    user: AuthUser,
    dto: SyncPushDto,
    options: PushOptions = {},
  ): Promise<SyncPushResult> {
    await this.assertBranchAccessForPush(tenantId, dto);
    const ordered = [...dto.operations].sort(
      (a, b) => a.deviceSequence - b.deviceSequence,
    );
    const results: SyncAck[] = [];
    const appliedInBatch = new Set<string>();
    const cashiers = new Map<string, Promise<ActingUser>>();
    let blockedBy: string | null = null;
    for (const op of ordered) {
      if (blockedBy) {
        results.push(this.ack(op, 'pending_dependency', { reason: blockedBy }));
        continue;
      }
      const ack = await this.apply(tenantId, user, dto.deviceId, op, options, {
        appliedInBatch,
        cashiers,
      });
      if (ack.status === 'accepted' || ack.status === 'already_applied') {
        appliedInBatch.add(op.deviceOperationId);
      }
      if (ack.status === 'pending_dependency' && ack.reason === 'retry_later') {
        blockedBy = `waiting_for:${op.deviceOperationId}`;
      }
      offlineSyncEventsTotal.inc({ event: `push_${ack.status}` });
      results.push(ack);
    }
    if (options.importedBy) {
      await this.auditService.record({
        tenantId,
        action: 'sync.imported',
        entityType: 'device',
        entityId: dto.deviceId ?? null,
        metadata: {
          operations: ordered.length,
          accepted: results.filter((r) => r.status === 'accepted').length,
          needsReview: results.filter((r) => r.status === 'needs_review')
            .length,
        },
      });
    }
    return { serverTime: new Date().toISOString(), results };
  }

  /**
   * Branch access (spec §9): a till enrolled on a register of branch X syncs
   * only for users with access to X, and every sale in the batch must be at a
   * register of the user's branches. Refused as a whole (nothing is recorded),
   * so the till keeps its queue for someone who may upload it.
   */
  private async assertBranchAccessForPush(tenantId: string, dto: SyncPushDto) {
    // Checked for every user, every-branch ones included: another store's device
    // or register id must be refused, never recorded here (tenant isolation)
    const manager = this.dataSource.manager;
    if (dto.deviceId) {
      const [device] = await manager.query<{ registerId: string | null }[]>(
        `SELECT "registerId" FROM devices WHERE id = $1 AND "tenantId" = $2`,
        [dto.deviceId, tenantId],
      );
      if (!device) throw new NotFoundException('Device not found');
      if (device.registerId) {
        await assertRegisterAccess(
          manager,
          tenantId,
          device.registerId,
          'Device not found',
        );
      }
    }
    const registerIds = new Set(
      dto.operations
        .map((op) => op.payload?.registerId)
        .filter((id): id is string => typeof id === 'string'),
    );
    for (const registerId of registerIds) {
      await assertRegisterAccess(manager, tenantId, registerId);
    }
  }

  private ack(
    op: SyncOperationDto,
    status: SyncAckStatus,
    extra: Partial<SyncAck> = {},
  ): SyncAck {
    return {
      deviceOperationId: op.deviceOperationId,
      deviceSequence: op.deviceSequence,
      status,
      reason: null,
      ...extra,
    };
  }

  private async apply(
    tenantId: string,
    user: AuthUser,
    batchDeviceId: string | undefined,
    op: SyncOperationDto,
    options: PushOptions,
    batch: {
      appliedInBatch: Set<string>;
      cashiers: Map<string, Promise<ActingUser>>;
    },
  ): Promise<SyncAck> {
    const repo = this.dataSource.getRepository(SyncOperation);
    const hash = payloadHash(op.payload);
    const existing = await repo.findOne({
      where: { tenantId, deviceOperationId: op.deviceOperationId },
    });

    const review = async (reason: string) => {
      // Never downgrade an operation that was applied before
      if (existing?.status === SyncOperationStatus.ACCEPTED) {
        return this.ack(op, 'needs_review', { reason });
      }
      await this.record(tenantId, op, existing, {
        status: SyncOperationStatus.NEEDS_REVIEW,
        reason,
        deviceId: batchDeviceId ?? null,
        importedBy: options.importedBy ?? null,
        payloadHash: hash,
      });
      return this.ack(op, 'needs_review', { reason });
    };

    if (op.schemaVersion > SUPPORTED_SCHEMA_VERSION) {
      return review('unsupported_schema_version');
    }
    if (hash !== op.payloadHash.toLowerCase()) {
      return review('payload_hash_mismatch');
    }
    if (existing?.status === SyncOperationStatus.ACCEPTED) {
      if (existing.payloadHash !== hash) {
        // Same id, different content: never applied twice, never silently dropped
        return this.ack(op, 'needs_review', { reason: 'operation_id_reused' });
      }
      const sale = existing.saleId
        ? await this.dataSource.getRepository(Sale).findOne({
            where: { tenantId, id: existing.saleId },
            select: { id: true, saleNumber: true },
          })
        : null;
      return this.ack(op, 'already_applied', {
        saleId: existing.saleId ?? undefined,
        saleNumber: sale?.saleNumber,
        leaseIssues: existing.leaseIssues as LeaseIssue[],
      });
    }

    const waiting = await this.missingDependencies(
      tenantId,
      op.dependsOn ?? [],
      batch.appliedInBatch,
    );
    if (waiting.length) {
      return this.ack(op, 'pending_dependency', {
        reason: `waiting_for:${waiting.join(',')}`,
      });
    }

    const raw = op.payload;
    if (
      typeof raw.idempotencyKey === 'string' &&
      raw.idempotencyKey !== op.deviceOperationId
    ) {
      return review('idempotency_key_mismatch');
    }
    const capturedAt =
      (typeof raw.offlineCapturedAt === 'string' && raw.offlineCapturedAt) ||
      op.capturedAt;
    if (!capturedAt) return review('missing_capture_time');
    // The till the batch comes from (checked above); a payload naming another
    // device is not this till's to upload
    if (
      typeof raw.deviceId === 'string' &&
      batchDeviceId &&
      raw.deviceId !== batchDeviceId
    ) {
      return review('device_mismatch');
    }
    const lease = op.lease
      ? verifyLease(op.lease, getOfflineLeaseSecret(this.configService))
      : null;
    // Without a batch device, the payload's device only when its lease names it
    const deviceId =
      batchDeviceId ??
      (typeof raw.deviceId === 'string' &&
      lease?.ok &&
      lease.claims.tid === tenantId &&
      lease.claims.did === raw.deviceId
        ? raw.deviceId
        : undefined);
    // A capture time the server can't believe: later than now, or before the
    // lease it was made under was issued
    const capturedMs = new Date(capturedAt).getTime();
    if (capturedMs > Date.now() + CLOCK_TOLERANCE_MS) {
      return review('captured_in_future');
    }
    if (lease?.ok && capturedMs < lease.claims.iat - CLOCK_TOLERANCE_MS) {
      return review('captured_before_lease');
    }
    const saleDto = plainToInstance(CreateSaleDto, {
      ...raw,
      idempotencyKey: op.deviceOperationId,
      offlineCapturedAt: capturedAt,
      deviceId,
      deviceSequence: op.deviceSequence,
    });
    const errors = await validate(saleDto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errors.length) {
      return review(`invalid_payload: ${flatten(errors).join('; ')}`);
    }

    const before = await this.dataSource.getRepository(Sale).findOne({
      where: { tenantId, idempotencyKey: op.deviceOperationId },
      select: { id: true },
    });
    // Another cashier than the uploader only on the word of a lease signed for
    // them on this till
    const vouched =
      !!op.actorId &&
      !!lease?.ok &&
      lease.claims.tid === tenantId &&
      lease.claims.uid === op.actorId &&
      !!deviceId &&
      lease.claims.did === deviceId;
    const actorKey = `${op.actorId ?? ''}:${vouched ? 'lease' : '-'}`;
    if (!batch.cashiers.has(actorKey)) {
      batch.cashiers.set(
        actorKey,
        this.cashierOf(tenantId, user, op.actorId ?? null, vouched),
      );
    }
    let sale: Sale;
    try {
      const actingUser = await batch.cashiers.get(actorKey)!;
      sale = await this.salesService.create(
        tenantId,
        user,
        saleDto,
        undefined,
        { actingUser, offline: { deviceId: deviceId ?? null } },
      );
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() < 500) {
        return review(messageOf(error).slice(0, 480));
      }
      this.logger.error(
        `Push of ${op.deviceOperationId} failed: ${String(error)}`,
      );
      // Transient: keep the order, the till retries with backoff
      return this.ack(op, 'pending_dependency', { reason: 'retry_later' });
    }

    const { leaseIssues, conflictCaseId } = await this.settle(
      tenantId,
      op,
      existing,
      sale,
      {
        lease,
        capturedAt: new Date(capturedAt),
        deviceId: sale.deviceId ?? deviceId ?? null,
        hash,
        importedBy: options.importedBy ?? null,
      },
    );
    return this.ack(op, before ? 'already_applied' : 'accepted', {
      saleId: sale.id,
      saleNumber: sale.saleNumber,
      leaseIssues,
      conflictCaseId,
    });
  }

  /**
   * Check the sale against its lease, record the acknowledgement and open the
   * offline_lease review case in one transaction. Runs again on a replay, so a
   * crash between the sale and this step is repaired by the till's resend.
   */
  private async settle(
    tenantId: string,
    op: SyncOperationDto,
    existing: SyncOperation | null,
    sale: Sale,
    input: {
      lease: LeaseVerification | null;
      capturedAt: Date;
      deviceId: string | null;
      hash: string;
      importedBy: string | null;
    },
  ): Promise<{ leaseIssues: LeaseIssue[]; conflictCaseId: string | null }> {
    const claims = input.lease?.ok ? input.lease.claims : null;
    return this.dataSource.transaction(async (manager) => {
      const [prior] = claims
        ? await manager.query<{ count: number; total: string | null }[]>(
            `SELECT COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::text AS total
               FROM sync_operations
              WHERE "tenantId" = $1 AND "leaseId" = $2 AND status = 'accepted'
                AND "deviceSequence" < $3 AND "deviceOperationId" <> $4`,
            [tenantId, claims.jti, op.deviceSequence, op.deviceOperationId],
          )
        : [{ count: 0, total: '0' }];
      const leaseIssues = assessOfflineSale({
        lease: input.lease,
        tenantId,
        deviceId: input.deviceId,
        branchId: sale.branchId ?? null,
        actorId: op.actorId ?? null,
        capturedAt: input.capturedAt,
        syncedAt: new Date(),
        saleTotal: Number(sale.total),
        discounted: Number(sale.discountAmount ?? 0) > 0,
        priorCount: prior.count,
        priorTotal: Number(prior.total ?? 0),
      });

      await this.record(
        tenantId,
        op,
        existing,
        {
          status: SyncOperationStatus.ACCEPTED,
          reason: null,
          saleId: sale.id,
          deviceId: input.deviceId,
          leaseId: claims?.jti ?? null,
          leaseIssues,
          amount: Number(sale.total),
          capturedAt: input.capturedAt,
          importedBy: input.importedBy,
          payloadHash: input.hash,
        },
        manager,
      );

      let conflictCaseId: string | null = null;
      if (leaseIssues.length) {
        const open = await manager.findOne(ConflictCase, {
          where: {
            tenantId,
            saleId: sale.id,
            type: ConflictCaseType.OFFLINE_LEASE,
          },
        });
        conflictCaseId =
          open?.id ??
          (
            await openConflictCase(manager, {
              tenantId,
              type: ConflictCaseType.OFFLINE_LEASE,
              saleId: sale.id,
              deviceId: input.deviceId,
              details: {
                saleNumber: sale.saleNumber,
                offlineNumber: sale.offlineNumber ?? null,
                deviceOperationId: op.deviceOperationId,
                deviceSequence: op.deviceSequence,
                issues: leaseIssues,
                capturedAt: input.capturedAt.toISOString(),
                syncedAt: new Date().toISOString(),
                total: Number(sale.total),
                actorId: op.actorId ?? null,
                leaseId: claims?.jti ?? null,
                leaseUserId: claims?.uid ?? null,
                leaseIssuedAt: claims
                  ? new Date(claims.iat).toISOString()
                  : null,
                leaseExpiresAt: claims
                  ? new Date(claims.exp).toISOString()
                  : null,
                limits: claims?.lim ?? null,
                priorOfflineSales: prior.count,
                priorOfflineTotal: Number(prior.total ?? 0),
                imported: !!input.importedBy,
              },
            })
          ).id;
        offlineSyncEventsTotal.inc({ event: 'lease_violation' });
      }
      return { leaseIssues, conflictCaseId };
    });
  }

  /**
   * Cashier of record of an uploaded sale: the operation's actor when a valid
   * lease for them on this till vouches for them (`vouched`) and they are an
   * active member of the store (active account). Their permissions, never more
   * than the uploader's, are what the offline_price check uses. Otherwise the
   * uploader, with a note.
   */
  private async cashierOf(
    tenantId: string,
    uploader: AuthUser,
    actorId: string | null,
    vouched: boolean,
  ): Promise<ActingUser> {
    if (actorId === uploader.id) {
      return { id: uploader.id, permissions: uploader.permissions ?? [] };
    }
    const fallback = (note: string): ActingUser => ({
      id: uploader.id,
      permissions: uploader.permissions ?? [],
      note,
    });
    if (!actorId)
      return fallback('No cashier on the operation: uploader recorded');
    if (!vouched) {
      return fallback(
        `Cashier ${actorId} has no lease on this till: uploader recorded`,
      );
    }
    const membership = await this.dataSource
      .getRepository(TenantMembership)
      .findOne({
        where: { tenantId, userId: actorId, status: MembershipStatus.ACTIVE },
        relations: { user: true },
      });
    if (!membership || membership.user?.status !== UserStatus.ACTIVE) {
      return fallback(
        `Cashier ${actorId} is not an active member: uploader recorded`,
      );
    }
    const role = await this.dataSource
      .getRepository(TenantRole)
      .findOne({ where: { tenantId, key: membership.role } });
    const uploaderPermissions = uploader.permissions ?? [];
    return {
      id: actorId,
      permissions: resolvePermissions(membership.role, role).filter((p) =>
        uploaderPermissions.includes(p),
      ),
    };
  }

  /** Upsert the operation's acknowledgement row. */
  private async record(
    tenantId: string,
    op: SyncOperationDto,
    existing: SyncOperation | null,
    values: Partial<SyncOperation>,
    manager?: EntityManager,
  ) {
    const row: Partial<SyncOperation> = {
      tenantId,
      deviceOperationId: op.deviceOperationId,
      deviceSequence: op.deviceSequence,
      opType: op.type,
      schemaVersion: op.schemaVersion,
      actorId: op.actorId ?? null,
      snapshot: op.snapshot ?? null,
      attempts: (existing?.attempts ?? 0) + 1,
      lastAttemptAt: new Date(),
      saleId: null,
      leaseId: null,
      leaseIssues: [],
      amount: 0,
      capturedAt: op.capturedAt ? new Date(op.capturedAt) : null,
      ...values,
    };
    try {
      await (manager ?? this.dataSource.manager)
        .createQueryBuilder()
        .insert()
        .into(SyncOperation)
        .values(row as QueryDeepPartialEntity<SyncOperation>)
        .orUpdate(
          Object.keys(row).filter(
            (k) => k !== 'tenantId' && k !== 'deviceOperationId',
          ),
          ['tenantId', 'deviceOperationId'],
        )
        .execute();
    } catch (error) {
      // Inside a transaction the error must abort it (the caller rolls back)
      if (manager) throw error;
      this.logger.warn(
        `Recording sync operation ${op.deviceOperationId} failed: ${String(error)}`,
      );
    }
  }

  private async missingDependencies(
    tenantId: string,
    ids: string[],
    appliedInBatch: Set<string>,
  ): Promise<string[]> {
    const pending = ids.filter((id) => !appliedInBatch.has(id));
    if (!pending.length) return [];
    const rows = await this.dataSource.query<{ id: string }[]>(
      `SELECT "deviceOperationId" AS id FROM sync_operations
        WHERE "tenantId" = $1 AND status = 'accepted' AND "deviceOperationId" = ANY($2)
       UNION
       SELECT "idempotencyKey" AS id FROM sales
        WHERE "tenantId" = $1 AND "idempotencyKey" = ANY($2)`,
      [tenantId, pending],
    );
    const done = new Set(rows.map((r) => r.id));
    return pending.filter((id) => !done.has(id));
  }
}
