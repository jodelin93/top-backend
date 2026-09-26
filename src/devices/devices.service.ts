import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, Raw, Repository } from 'typeorm';
import {
  assertRegisterAccess,
  branchScope,
  branchWhere,
  scopedBranchIds,
} from '../auth/branch-scope';
import { Device } from './device.entity';
import {
  HeartbeatDto,
  RegisterDeviceDto,
  UpdateDeviceDto,
} from './devices.dto';
import {
  assessDevice,
  DeviceHealth,
  isLeaseValid,
  leaseExpiry,
} from './device-health';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../sessions/sessions.service';
import { SettingsService } from '../settings/settings.service';
import { requestContext } from '../common/context/request-context';
import { Register } from '../database/entities/register.entity';
import { ConflictCaseType } from '../database/entities/conflict-case.entity';
import { openConflictCase } from '../sales/conflict-cases.service';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import {
  getOfflineLeaseSecret,
  issueLeaseClaims,
  OfflineLeaseClaims,
  signLease,
} from '../sync/offline-lease';
import {
  deviceLastSeenSeconds,
  devicePendingSales,
  offlineSyncEventsTotal,
} from '../metrics/metrics.registry';

const DEFAULT_STALE_MINUTES = 60;

interface SequenceStats {
  receivedCount: number;
  maxReceivedSequence: number | null;
  lastSaleAt: Date | null;
}

export type DeviceView = Omit<Device, 'tenant'> & {
  health: DeviceHealth;
  receivedCount: number;
  maxReceivedSequence: number | null;
  lastSaleAt: Date | null;
  // Sync dashboard: open review cases raised by the till's sales, and operations
  // the server answered needs_review (spec §19)
  openConflicts: number;
  needsReviewOps: number;
};

interface SyncStats {
  openConflicts: number;
  needsReviewOps: number;
}

// Signed offline lease handed to the till (see src/sync/offline-lease.ts)
export interface IssuedLease {
  lease: string;
  leaseClaims: OfflineLeaseClaims;
  leaseIssuedAt: Date;
  leaseExpiresAt: Date;
}

@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);

  constructor(
    @InjectRepository(Device)
    private readonly deviceRepository: Repository<Device>,
    private readonly dataSource: DataSource,
    private readonly settingsService: SettingsService,
    private readonly auditService: AuditService,
    private readonly configService: ConfigService,
    @Optional() private readonly sessionsService?: SessionsService,
  ) {}

  /**
   * Register a till, or re-register one that already has an id (keeps its history).
   */
  async register(
    tenantId: string,
    userId: string,
    dto: RegisterDeviceDto,
  ): Promise<Device> {
    const now = new Date();
    const userAgent = requestContext.get()?.userAgent ?? null;
    // A till is enrolled on a register of one of the user's branches (spec §9)
    await this.assertRegisterInScope(tenantId, dto.registerId);
    if (dto.deviceId) {
      const existing = await this.deviceRepository.findOne({
        where: { id: dto.deviceId, tenantId },
      });
      if (existing) {
        await this.assertRegisterInScope(
          tenantId,
          existing.registerId,
          'Device not found',
        );
        assertNotLost(existing);
        existing.lastSeenAt = now;
        existing.lastSeenBy = userId;
        existing.userAgent = userAgent ?? existing.userAgent;
        if (dto.registerId) existing.registerId = dto.registerId;
        if (dto.appVersion) existing.appVersion = dto.appVersion;
        return this.deviceRepository.save(existing);
      }
    }

    const count = await this.deviceRepository.count({ where: { tenantId } });
    const device = await this.deviceRepository.save(
      this.deviceRepository.create({
        tenantId,
        name: dto.name?.trim() || `Till ${count + 1}`,
        type: dto.type ?? 'pos',
        registerId: dto.registerId ?? null,
        userAgent,
        appVersion: dto.appVersion ?? null,
        registeredAt: now,
        registeredBy: userId,
        lastSeenAt: now,
        lastSeenBy: userId,
      }),
    );
    await this.auditService.record({
      tenantId,
      action: 'device.registered',
      entityType: 'device',
      entityId: device.id,
      changes: { after: { name: device.name, registerId: device.registerId } },
    });
    return device;
  }

  /** The till reports it is alive and how many offline sales it still holds. */
  async heartbeat(
    tenantId: string,
    user: AuthUser,
    id: string,
    dto: HeartbeatDto,
  ) {
    const device = await this.get(tenantId, id);
    assertNotLost(device);
    await this.assertRegisterInScope(tenantId, dto.registerId);
    const now = new Date();
    device.lastSeenAt = now;
    device.lastSeenBy = user.id;
    device.pendingSales = dto.pendingSales;
    device.failedSales = dto.failedSales ?? 0;
    device.oldestPendingAt =
      dto.pendingSales > 0 && dto.oldestPendingAt
        ? new Date(dto.oldestPendingAt)
        : null;
    device.pendingAmount = dto.pendingSales > 0 ? (dto.pendingAmount ?? 0) : 0;
    device.syncRetries = dto.syncRetries ?? 0;
    if (dto.lastSequence !== undefined) {
      device.lastSequence = Math.max(device.lastSequence, dto.lastSequence);
    }
    if (dto.registerId) device.registerId = dto.registerId;
    if (dto.appVersion) device.appVersion = dto.appVersion;
    if (dto.lastSyncAt) {
      const reported = new Date(dto.lastSyncAt);
      // Ignore clocks running ahead of the server
      const syncAt = reported > now ? now : reported;
      if (!device.lastSyncAt || syncAt > device.lastSyncAt) {
        device.lastSyncAt = syncAt;
      }
    }
    // A live till gets a fresh signed lease with every heartbeat
    const issued = device.revokedAt
      ? null
      : await this.issueLease(tenantId, user, device, now);
    await this.deviceRepository.save(device);

    const labels = { tenant: tenantId, device: id };
    devicePendingSales.set(labels, device.pendingSales);
    deviceLastSeenSeconds.set(labels, Math.floor(now.getTime() / 1000));
    offlineSyncEventsTotal.inc({ event: 'heartbeat' });

    return {
      id: device.id,
      revokedAt: device.revokedAt,
      leaseExpiresAt: device.leaseExpiresAt,
      lease: issued?.lease ?? null,
      leaseClaims: issued?.leaseClaims ?? null,
      serverTime: now,
    };
  }

  /**
   * Obtain / renew the offline lease: the till may sell offline until
   * now + offlineLeaseHours. Revoked devices can't renew.
   */
  async renewLease(
    tenantId: string,
    user: AuthUser,
    id: string,
    registerId?: string,
  ) {
    const device = await this.get(tenantId, id);
    assertNotLost(device);
    if (device.revokedAt) {
      offlineSyncEventsTotal.inc({ event: 'lease_denied' });
      throw new ForbiddenException({
        message:
          'This device has been revoked by an administrator and cannot sell offline',
        error: 'Forbidden',
        code: 'DEVICE_REVOKED',
      });
    }
    await this.assertRegisterInScope(tenantId, registerId);
    const { offlineLeaseHours } =
      await this.settingsService.getSettings(tenantId);
    const now = new Date();
    if (registerId) device.registerId = registerId;
    const issued = await this.issueLease(tenantId, user, device, now);
    device.lastSeenAt = now;
    device.lastSeenBy = user.id;
    await this.deviceRepository.save(device);
    offlineSyncEventsTotal.inc({ event: 'lease_renewed' });
    return {
      id: device.id,
      offlineLeaseHours,
      leaseValid: isLeaseValid(device, now),
      ...issued,
      serverTime: now,
    };
  }

  /**
   * Sign a lease for this till and cashier: store, branch (of the till's
   * register), the offline permissions the cashier holds, the store's offline
   * limits and the validity window. Sets the device's lease dates (caller saves).
   */
  private async issueLease(
    tenantId: string,
    user: AuthUser,
    device: Device,
    now: Date,
  ): Promise<IssuedLease> {
    const settings = await this.settingsService.getSettings(tenantId);
    const register = device.registerId
      ? await this.dataSource
          .getRepository(Register)
          .findOne({ where: { id: device.registerId, tenantId } })
      : null;
    const expiresAt = leaseExpiry(now, settings.offlineLeaseHours);
    const claims = issueLeaseClaims({
      tenantId,
      branchId: register?.branchId ?? null,
      registerId: register?.id ?? null,
      deviceId: device.id,
      userId: user.id,
      permissions: user.permissions ?? [],
      limits: {
        maxSaleAmount: Number(settings.offlineMaxSaleAmount) || 0,
        maxSales: Number(settings.offlineMaxSales) || 0,
        maxTotal: Number(settings.offlineMaxTotal) || 0,
      },
      issuedAt: now,
      expiresAt,
    });
    device.leaseExpiresAt = expiresAt;
    device.leaseIssuedAt = now;
    return {
      lease: signLease(claims, getOfflineLeaseSecret(this.configService)),
      leaseClaims: claims,
      leaseIssuedAt: now,
      leaseExpiresAt: expiresAt,
    };
  }

  async list(tenantId: string, staleMinutes = DEFAULT_STALE_MINUTES) {
    const devices = await this.deviceRepository.find({
      where: { tenantId, ...(await this.deviceScopeWhere(tenantId)) },
      order: { revokedAt: { direction: 'DESC', nulls: 'FIRST' }, name: 'ASC' },
    });
    const ids = devices.map((d) => d.id);
    const [stats, sync] = await Promise.all([
      this.sequenceStats(tenantId, ids),
      this.syncStats(tenantId, ids),
    ]);
    const now = new Date();
    return devices.map((d) =>
      this.view(d, stats.get(d.id), now, staleMinutes, sync.get(d.id)),
    );
  }

  /** One device, with the missing sequence numbers listed. */
  async detail(tenantId: string, id: string) {
    const device = await this.get(tenantId, id);
    const [stats, sync] = await Promise.all([
      this.sequenceStats(tenantId, [id]),
      this.syncStats(tenantId, [id]),
    ]);
    const view = this.view(
      device,
      stats.get(id),
      new Date(),
      DEFAULT_STALE_MINUTES,
      sync.get(id),
    );
    return {
      ...view,
      missingSequences:
        view.health.missingCount > 0
          ? await this.missingSequences(
              tenantId,
              id,
              view.health.expectedSequence,
            )
          : [],
    };
  }

  /**
   * Data freshness for dashboards: devices with unsynced sales, devices not seen
   * recently, sequence gaps and the time of the latest data.
   */
  async summary(tenantId: string, staleMinutes = DEFAULT_STALE_MINUTES) {
    const devices = await this.list(tenantId, staleMinutes);
    const active = devices.filter((d) => !d.revokedAt);
    const [latest] = await this.dataSource.query<{ lastSaleAt: Date | null }[]>(
      `SELECT MAX(created_at) AS "lastSaleAt" FROM sales
        WHERE "tenantId" = $1 AND ($2::uuid[] IS NULL OR "branchId" = ANY($2::uuid[]))`,
      [tenantId, scopedBranchIds()],
    );
    const lastSyncAt = active.reduce<Date | null>(
      (max, d) =>
        d.lastSyncAt && (!max || d.lastSyncAt > max) ? d.lastSyncAt : max,
      null,
    );
    const brief = (d: DeviceView) => ({
      id: d.id,
      name: d.name,
      status: d.health.status,
      pendingSales: d.pendingSales,
      failedSales: d.failedSales,
      unaccountedSales: d.health.unaccountedCount,
      lastSeenAt: d.lastSeenAt,
      lastSyncAt: d.lastSyncAt,
      oldestPendingAt: d.oldestPendingAt,
      pendingAmount: d.pendingAmount,
      syncRetries: d.syncRetries,
      openConflicts: d.openConflicts,
      leaseExpiresAt: d.leaseExpiresAt,
    });
    const withPending = active.filter((d) => d.pendingSales > 0);
    const notSeen = active.filter((d) => d.health.stale);
    const withGaps = active.filter((d) => d.health.unaccountedCount > 0);
    return {
      generatedAt: new Date(),
      staleMinutes,
      devices: { total: devices.length, active: active.length },
      pendingSalesTotal: active.reduce((sum, d) => sum + d.pendingSales, 0),
      failedSalesTotal: active.reduce((sum, d) => sum + d.failedSales, 0),
      // Money at stake in tills' unsynced queues, and the oldest unsynced capture
      pendingAmountTotal:
        Math.round(
          active.reduce((sum, d) => sum + Number(d.pendingAmount ?? 0), 0) *
            100,
        ) / 100,
      oldestPendingAt: active.reduce<Date | null>(
        (min, d) =>
          d.oldestPendingAt && (!min || d.oldestPendingAt < min)
            ? d.oldestPendingAt
            : min,
        null,
      ),
      openConflictsTotal: active.reduce((sum, d) => sum + d.openConflicts, 0),
      devicesWithPendingSales: withPending.map(brief),
      devicesNotSeenRecently: notSeen.map(brief),
      devicesWithGaps: withGaps.map(brief),
      lastSaleAt: latest?.lastSaleAt ?? null,
      lastDeviceSyncAt: lastSyncAt,
      // Figures may be incomplete while any till still holds unsynced sales
      dataComplete: withPending.length === 0 && withGaps.length === 0,
    };
  }

  async update(tenantId: string, id: string, dto: UpdateDeviceDto) {
    const device = await this.get(tenantId, id);
    if (dto.registerId)
      await this.assertRegisterInScope(tenantId, dto.registerId);
    const before = { name: device.name, registerId: device.registerId };
    if (dto.name !== undefined) device.name = dto.name.trim();
    if (dto.registerId !== undefined) device.registerId = dto.registerId;
    await this.deviceRepository.save(device);
    await this.auditService.record({
      tenantId,
      action: 'device.updated',
      entityType: 'device',
      entityId: id,
      changes: {
        before,
        after: { name: device.name, registerId: device.registerId },
      },
    });
    return this.detail(tenantId, id);
  }

  /** Block the device: its offline lease ends now and can't be renewed. */
  async revoke(tenantId: string, userId: string, id: string, reason?: string) {
    const device = await this.get(tenantId, id);
    if (!device.revokedAt) {
      const now = new Date();
      device.revokedAt = now;
      device.revokedBy = userId;
      device.revokedReason = reason?.trim() || null;
      device.leaseExpiresAt = now;
      await this.deviceRepository.save(device);
      await this.auditService.record({
        tenantId,
        action: 'device.revoked',
        entityType: 'device',
        entityId: id,
        reason: device.revokedReason,
        metadata: { name: device.name, pendingSales: device.pendingSales },
      });
      devicePendingSales.remove({ tenant: tenantId, device: id });
      deviceLastSeenSeconds.remove({ tenant: tenantId, device: id });
    }
    await this.sessionsService?.revokeForDevice(tenantId, id, 'device_revoked');
    return this.detail(tenantId, id);
  }

  /**
   * Lost / abandoned till (spec §13/§19): revoke it for good, keep the number of
   * sales it still held (queued + never received), open a lost_device review
   * case for management, and refuse any further sync from it.
   */
  async markLost(
    tenantId: string,
    userId: string,
    id: string,
    reason?: string,
  ) {
    const current = await this.detail(tenantId, id);
    if (current.lostAt) return current;
    const unsynced =
      (current.pendingSales ?? 0) +
      Math.max(0, current.health.unaccountedCount ?? 0);
    const now = new Date();
    const note = reason?.trim() || null;
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(Device);
      const device = await repo.findOne({
        where: { id, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!device) throw new NotFoundException('Device not found');
      if (device.lostAt) return;
      if (!device.revokedAt) {
        device.revokedAt = now;
        device.revokedBy = userId;
        device.revokedReason = note ?? 'Lost device';
      }
      device.leaseExpiresAt = now;
      device.lostAt = now;
      device.lostBy = userId;
      device.lostUnsyncedCount = unsynced;
      await repo.save(device);
      const conflict = await openConflictCase(manager, {
        tenantId,
        type: ConflictCaseType.LOST_DEVICE,
        deviceId: id,
        details: {
          deviceName: device.name,
          registerId: device.registerId,
          reason: note,
          unsyncedSales: unsynced,
          pendingSales: device.pendingSales,
          failedSales: device.failedSales,
          pendingAmount: current.pendingAmount ?? null,
          unaccountedSales: current.health.unaccountedCount ?? 0,
          missingSequences: current.missingSequences.slice(0, 50),
          lastSeenAt: device.lastSeenAt,
          lastSyncAt: device.lastSyncAt,
        },
      });
      await this.auditService.record(
        {
          tenantId,
          action: 'device.marked_lost',
          entityType: 'device',
          entityId: id,
          reason: note,
          metadata: {
            name: device.name,
            unsyncedSales: unsynced,
            conflictCaseId: conflict.id,
          },
        },
        manager,
      );
    });
    forgetLostDevice(id);
    await this.sessionsService?.revokeForDevice(tenantId, id, 'device_lost');
    devicePendingSales.remove({ tenant: tenantId, device: id });
    deviceLastSeenSeconds.remove({ tenant: tenantId, device: id });
    return this.detail(tenantId, id);
  }

  /** Undo a revocation (the till must renew its lease online again). */
  async restore(tenantId: string, id: string) {
    const device = await this.get(tenantId, id);
    assertNotLost(device);
    if (device.revokedAt) {
      device.revokedAt = null;
      device.revokedBy = null;
      device.revokedReason = null;
      await this.deviceRepository.save(device);
      await this.auditService.record({
        tenantId,
        action: 'device.restored',
        entityType: 'device',
        entityId: id,
        metadata: { name: device.name },
      });
    }
    return this.detail(tenantId, id);
  }

  private async get(tenantId: string, id: string): Promise<Device> {
    const device = await this.deviceRepository.findOne({
      where: { id, tenantId },
    });
    if (!device) throw new NotFoundException('Device not found');
    // A till enrolled at another branch is "not found" (spec §9)
    await this.assertRegisterInScope(
      tenantId,
      device.registerId,
      'Device not found',
    );
    return device;
  }

  /** 404 unless the register (when given) is at one of the user's branches */
  private assertRegisterInScope(
    tenantId: string,
    registerId: string | null | undefined,
    notFound = 'Register not found',
  ) {
    if (!registerId) return Promise.resolve();
    return assertRegisterAccess(
      this.dataSource.manager,
      tenantId,
      registerId,
      notFound,
    );
  }

  /**
   * Devices a branch-limited user sees: those enrolled on their branches'
   * registers, and those not bound to a register yet
   */
  private async deviceScopeWhere(tenantId: string) {
    const scope = branchScope();
    if (scope === null) return {};
    const registers = await this.dataSource.getRepository(Register).find({
      where: { tenantId, ...branchWhere(scope) },
      select: { id: true },
    });
    return {
      registerId: Raw(
        (column) => `(${column} IS NULL OR ${column} = ANY(:deviceRegisters))`,
        { deviceRegisters: registers.map((r) => r.id) },
      ),
    };
  }

  private view(
    device: Device,
    stats: SequenceStats | undefined,
    now: Date,
    staleMinutes = DEFAULT_STALE_MINUTES,
    sync?: SyncStats,
  ): DeviceView {
    const { tenant: _tenant, ...rest } = device;
    void _tenant;
    const receivedCount = stats?.receivedCount ?? 0;
    const maxReceivedSequence = stats?.maxReceivedSequence ?? null;
    return {
      ...rest,
      openConflicts: sync?.openConflicts ?? 0,
      needsReviewOps: sync?.needsReviewOps ?? 0,
      receivedCount,
      maxReceivedSequence,
      lastSaleAt: stats?.lastSaleAt ?? null,
      health: assessDevice({
        lastSequence: device.lastSequence,
        maxReceivedSequence,
        receivedCount,
        pendingSales: device.pendingSales,
        failedSales: device.failedSales,
        lastSeenAt: device.lastSeenAt,
        revokedAt: device.revokedAt,
        leaseExpiresAt: device.leaseExpiresAt,
        now,
        staleAfterMs: staleMinutes * 60_000,
      }),
    };
  }

  /** Open review cases and needs_review operations per device (sync dashboard). */
  private async syncStats(
    tenantId: string,
    deviceIds: string[],
  ): Promise<Map<string, SyncStats>> {
    const result = new Map<string, SyncStats>();
    if (deviceIds.length === 0) return result;
    try {
      const rows = await this.dataSource.query<
        { deviceId: string; openConflicts: number; needsReviewOps: number }[]
      >(
        `SELECT d.id AS "deviceId",
                (SELECT COUNT(*)::int FROM conflict_cases c
                  WHERE c."tenantId" = $1 AND c."deviceId" = d.id AND c.status = 'open') AS "openConflicts",
                (SELECT COUNT(*)::int FROM sync_operations o
                  WHERE o."tenantId" = $1 AND o."deviceId" = d.id AND o.status = 'needs_review') AS "needsReviewOps"
           FROM unnest($2::uuid[]) AS d(id)`,
        [tenantId, deviceIds],
      );
      rows.forEach((row) => result.set(row.deviceId, row));
    } catch (err) {
      // sync_operations not migrated yet
      this.logger.warn(`Device sync stats unavailable: ${String(err)}`);
    }
    return result;
  }

  /** Per-device counts of the sequences the server has received. */
  private async sequenceStats(
    tenantId: string,
    deviceIds: string[],
  ): Promise<Map<string, SequenceStats>> {
    const result = new Map<string, SequenceStats>();
    if (deviceIds.length === 0) return result;
    try {
      const rows = await this.dataSource.query<
        {
          deviceId: string;
          receivedCount: number;
          maxReceivedSequence: number | null;
          lastSaleAt: Date | null;
        }[]
      >(
        `SELECT "deviceId",
                COUNT(DISTINCT "deviceSequence")::int AS "receivedCount",
                MAX("deviceSequence")::int AS "maxReceivedSequence",
                MAX(created_at) AS "lastSaleAt"
           FROM sales
          WHERE "tenantId" = $1 AND "deviceId" = ANY($2) AND "deviceSequence" IS NOT NULL
          GROUP BY "deviceId"`,
        [tenantId, deviceIds],
      );
      rows.forEach((row) => result.set(row.deviceId, row));
    } catch (err) {
      // sales.deviceId / deviceSequence not migrated yet: report no received sequences
      this.logger.warn(`Device sequence stats unavailable: ${String(err)}`);
    }
    return result;
  }

  private async missingSequences(
    tenantId: string,
    deviceId: string,
    upTo: number,
  ): Promise<number[]> {
    try {
      const rows = await this.dataSource.query<{ seq: number }[]>(
        `SELECT s::int AS seq FROM generate_series(1, $3::int) s
          WHERE NOT EXISTS (
            SELECT 1 FROM sales
             WHERE "tenantId" = $1 AND "deviceId" = $2 AND "deviceSequence" = s)
          ORDER BY s LIMIT 200`,
        [tenantId, deviceId, upTo],
      );
      return rows.map((r) => r.seq);
    } catch {
      return [];
    }
  }
}

/** A lost device is refused everywhere (register, heartbeat, lease, restore, sync) */
export function assertNotLost(device: Pick<Device, 'lostAt'>) {
  if (device.lostAt) {
    offlineSyncEventsTotal.inc({ event: 'lost_device_rejected' });
    throw new ForbiddenException({
      message:
        'This till was marked lost by an administrator; register a new till',
      error: 'Forbidden',
      code: 'DEVICE_LOST',
    });
  }
}

// Lost-device lookups of LostDeviceInterceptor, cached briefly per process
const LOST_CACHE_MS = 30_000;
const lostCache = new Map<string, { lost: boolean; at: number }>();

export function forgetLostDevice(id: string) {
  lostCache.delete(id);
}

export async function isLostDevice(
  dataSource: Pick<DataSource, 'query'>,
  id: string,
  now = Date.now(),
): Promise<boolean> {
  const cached = lostCache.get(id);
  if (cached && now - cached.at < LOST_CACHE_MS) return cached.lost;
  let lost = false;
  try {
    const rows = await dataSource.query<unknown[]>(
      `SELECT 1 FROM devices WHERE id = $1 AND "lostAt" IS NOT NULL`,
      [id],
    );
    lost = rows.length > 0;
  } catch {
    // devices."lostAt" not migrated yet
    lost = false;
  }
  lostCache.set(id, { lost, at: now });
  if (lostCache.size > 5_000) lostCache.clear();
  return lost;
}
