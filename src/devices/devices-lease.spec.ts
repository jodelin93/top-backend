import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { verifyLease } from '../sync/offline-lease';
import { Device } from './device.entity';
import { DevicesService } from './devices.service';

const SECRET = 'devices-spec-offline-lease-secret-012345';

describe('DevicesService offline lease', () => {
  let device: Partial<Device>;
  let service: DevicesService;
  const user = {
    id: 'u1',
    permissions: ['pos.sell', 'pos.hold', 'reports.view'],
  } as unknown as AuthUser;

  beforeEach(() => {
    device = {
      id: 'd1',
      tenantId: 't1',
      registerId: 'r1',
      revokedAt: null,
      lastSequence: 0,
      pendingSales: 0,
      failedSales: 0,
      lastSyncAt: null,
    };
    const repo = {
      findOne: jest.fn(() => Promise.resolve(device)),
      save: jest.fn((d: Device) => Promise.resolve(d)),
    };
    const dataSource = {
      getRepository: () => ({
        findOne: () => Promise.resolve({ id: 'r1', branchId: 'b1' }),
      }),
      // The till's register belongs to this store (tenant-isolation check)
      manager: {
        query: jest.fn(() => Promise.resolve([{ branchId: 'b1' }])),
      },
    };
    const settings = {
      getSettings: jest.fn(() =>
        Promise.resolve({
          offlineLeaseHours: 12,
          offlineMaxSaleAmount: 250,
          offlineMaxSales: 40,
          offlineMaxTotal: 5000,
        }),
      ),
    };
    service = new DevicesService(
      repo as unknown as Repository<Device>,
      dataSource as unknown as DataSource,
      settings as unknown as SettingsService,
      { record: jest.fn() } as unknown as AuditService,
      {
        get: (k: string) => (k === 'OFFLINE_LEASE_SECRET' ? SECRET : undefined),
      } as unknown as ConfigService,
    );
  });

  it('issues a signed lease binding store, branch, device, cashier, permissions and limits', async () => {
    const before = Date.now();
    const result = await service.renewLease('t1', user, 'd1');
    const verified = verifyLease(result.lease, SECRET);
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.claims).toMatchObject({
      tid: 't1',
      bid: 'b1',
      rid: 'r1',
      did: 'd1',
      uid: 'u1',
      perms: ['pos.sell', 'pos.hold'],
      lim: { maxSaleAmount: 250, maxSales: 40, maxTotal: 5000 },
    });
    expect(verified.claims.exp - verified.claims.iat).toBe(12 * 3600_000);
    expect(verified.claims.iat).toBeGreaterThanOrEqual(before);
    expect(device.leaseExpiresAt?.getTime()).toBe(verified.claims.exp);
    expect(device.leaseIssuedAt?.getTime()).toBe(verified.claims.iat);
  });

  it('refuses a lease to a revoked till', async () => {
    device.revokedAt = new Date();
    await expect(service.renewLease('t1', user, 'd1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('heartbeat: stores the queue details and hands out a fresh lease', async () => {
    const result = await service.heartbeat('t1', user, 'd1', {
      pendingSales: 3,
      failedSales: 1,
      oldestPendingAt: '2026-09-24T08:00:00.000Z',
      pendingAmount: 120.5,
      syncRetries: 4,
    });
    expect(device).toMatchObject({
      pendingSales: 3,
      failedSales: 1,
      pendingAmount: 120.5,
      syncRetries: 4,
    });
    expect(device.oldestPendingAt?.toISOString()).toBe(
      '2026-09-24T08:00:00.000Z',
    );
    expect(verifyLease(result.lease, SECRET).ok).toBe(true);

    device.revokedAt = new Date();
    const revoked = await service.heartbeat('t1', user, 'd1', {
      pendingSales: 0,
    });
    expect(revoked.lease).toBeNull();
    expect(device.oldestPendingAt).toBeNull();
    expect(device.pendingAmount).toBe(0);
  });
});
