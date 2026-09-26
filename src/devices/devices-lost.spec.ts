import { ForbiddenException } from '@nestjs/common';
import { of, lastValueFrom } from 'rxjs';
import type { ConfigService } from '@nestjs/config';
import type { ExecutionContext } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { Device } from './device.entity';
import { DevicesService, forgetLostDevice } from './devices.service';
import { LostDeviceInterceptor } from './lost-device.interceptor';
import { ConflictCaseType } from '../database/entities/conflict-case.entity';
import type { AuditService } from '../audit/audit.service';
import type { SettingsService } from '../settings/settings.service';
import type { AuthUser } from '../auth/strategies/jwt.strategy';

const TENANT = 'tenant-1';
const DEVICE_ID = '7b0c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

function setup() {
  const device: Device = Object.assign(new Device(), {
    id: DEVICE_ID,
    tenantId: TENANT,
    name: 'Till 2',
    registerId: 'reg-1',
    pendingSales: 1,
    failedSales: 1,
    lastSequence: 12,
    lastSeenAt: new Date('2026-09-20T10:00:00Z'),
    lastSyncAt: new Date('2026-09-20T09:00:00Z'),
    revokedAt: null,
    lostAt: null,
    leaseExpiresAt: new Date('2026-09-21T10:00:00Z'),
  });
  const repo = {
    findOne: jest.fn(() => Promise.resolve(device)),
    save: jest.fn((d: Device) => Promise.resolve(Object.assign(device, d))),
  };
  const cases: Record<string, unknown>[] = [];
  const manager = {
    getRepository: jest.fn(() => repo),
    create: jest.fn((_e: unknown, v: Record<string, unknown>) => v),
    save: jest.fn((v: Record<string, unknown>) => {
      cases.push(v);
      return Promise.resolve({ ...v, id: 'case-1' });
    }),
  } as unknown as EntityManager;
  const query = jest.fn((sql: string) => {
    // The server received sequences 1..10 (2 of the 12 never arrived)
    if (sql.includes('COUNT(DISTINCT "deviceSequence")')) {
      return Promise.resolve([
        {
          deviceId: DEVICE_ID,
          receivedCount: 10,
          maxReceivedSequence: 10,
          lastSaleAt: null,
        },
      ]);
    }
    if (sql.includes('generate_series')) {
      return Promise.resolve([{ seq: 11 }, { seq: 12 }]);
    }
    return Promise.resolve([]);
  });
  const dataSource = {
    query,
    // The till's register belongs to this store (tenant-isolation check)
    manager: {
      query: jest.fn(() => Promise.resolve([{ branchId: 'branch-1' }])),
    },
    transaction: jest.fn((cb: (m: EntityManager) => Promise<unknown>) =>
      cb(manager),
    ),
  } as unknown as DataSource;
  const audit = { record: jest.fn(() => Promise.resolve()) };
  const settings = {
    getSettings: jest.fn(() => Promise.resolve({ offlineLeaseHours: 24 })),
  };
  const service = new DevicesService(
    repo as unknown as Repository<Device>,
    dataSource,
    settings as unknown as SettingsService,
    audit as unknown as AuditService,
    { get: jest.fn() } as unknown as ConfigService,
  );
  return { service, device, cases, audit };
}

describe('DevicesService.markLost', () => {
  it('revokes the till, keeps its unsynced count and opens a lost_device case', async () => {
    const { service, device, cases, audit } = setup();
    const result = await service.markLost(
      TENANT,
      'admin-1',
      DEVICE_ID,
      'Stolen at night',
    );
    expect(device.revokedAt).toBeInstanceOf(Date);
    expect(device.lostAt).toBeInstanceOf(Date);
    expect(device.lostBy).toBe('admin-1');
    // 1 queued on the till + 1 more sequence never received (2 missing in all)
    expect(device.lostUnsyncedCount).toBe(2);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      type: ConflictCaseType.LOST_DEVICE,
      deviceId: DEVICE_ID,
      details: expect.objectContaining({
        unsyncedSales: 2,
        missingSequences: [11, 12],
        reason: 'Stolen at night',
      }) as unknown,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'device.marked_lost' }),
      expect.anything(),
    );
    expect(result.lostAt).toBeInstanceOf(Date);

    // Marking it lost again changes nothing
    await service.markLost(TENANT, 'admin-1', DEVICE_ID);
    expect(cases).toHaveLength(1);
  });

  it('refuses heartbeats, leases, re-registration and restore from a lost till', async () => {
    const { service, device } = setup();
    device.lostAt = new Date();
    const user = { id: 'cashier-1', permissions: [] } as unknown as AuthUser;
    await expect(
      service.heartbeat(TENANT, user, DEVICE_ID, { pendingSales: 0 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.renewLease(TENANT, user, DEVICE_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.register(TENANT, user.id, { deviceId: DEVICE_ID }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.restore(TENANT, DEVICE_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('LostDeviceInterceptor', () => {
  function context(body: unknown): ExecutionContext {
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ body }) }),
    } as unknown as ExecutionContext;
  }

  it('blocks any sync carrying a lost device id', async () => {
    forgetLostDevice(DEVICE_ID);
    const query = jest.fn(() => Promise.resolve([{}]));
    const interceptor = new LostDeviceInterceptor({
      query,
    } as unknown as DataSource);
    const next = { handle: jest.fn(() => of('ok')) };
    await expect(
      lastValueFrom(
        interceptor.intercept(context({ deviceId: DEVICE_ID }), next),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(next.handle).not.toHaveBeenCalled();
  });

  it('lets other requests through', async () => {
    forgetLostDevice(DEVICE_ID);
    const query = jest.fn(() => Promise.resolve([]));
    const interceptor = new LostDeviceInterceptor({
      query,
    } as unknown as DataSource);
    const next = { handle: jest.fn(() => of('ok')) };
    await expect(
      lastValueFrom(
        interceptor.intercept(context({ deviceId: DEVICE_ID }), next),
      ),
    ).resolves.toBe('ok');
    await expect(
      lastValueFrom(interceptor.intercept(context({}), next)),
    ).resolves.toBe('ok');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
