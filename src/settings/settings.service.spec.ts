import { StorageService } from '../storage/storage.service';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Tenant } from '../database/entities/tenant.entity';
import { TaxRate } from '../database/entities/tax-rate.entity';
import { AuditService } from '../audit/audit.service';
import { SettingsVersion } from './settings-version.entity';
import { SettingsService } from './settings.service';

describe('SettingsService (effective settings)', () => {
  let service: SettingsService;
  let tenant: Partial<Tenant>;
  let versions: Partial<SettingsVersion>[];
  const audit = { record: jest.fn() };

  const tenantRepository = {
    findOneOrFail: jest.fn(() => Promise.resolve({ ...tenant })),
  };
  const versionRepository = {
    find: jest.fn(() => Promise.resolve(versions.filter((v) => !v.appliedAt))),
  };
  // Minimal transaction manager over the in-memory rows above
  const manager = {
    getRepository: (entity: unknown) =>
      entity === Tenant
        ? {
            findOne: () => Promise.resolve(tenant),
            save: (t: Partial<Tenant>) => {
              tenant = { ...t };
              return Promise.resolve(t);
            },
          }
        : {
            find: () => Promise.resolve(versions.filter((v) => !v.appliedAt)),
            save: (v: Partial<SettingsVersion>) => Promise.resolve(v),
          },
  };
  const dataSource = {
    transaction: jest.fn((fn: (m: typeof manager) => unknown) => fn(manager)),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    tenant = { id: 't1', name: 'Shop', settings: { maxDiscountPercent: 15 } };
    versions = [];
    const module = await Test.createTestingModule({
      providers: [
        {
          provide: StorageService,
          useValue: { newKey: jest.fn(), put: jest.fn(), publicUrl: jest.fn() },
        },
        SettingsService,
        { provide: getRepositoryToken(Tenant), useValue: tenantRepository },
        { provide: getRepositoryToken(TaxRate), useValue: {} },
        {
          provide: getRepositoryToken(SettingsVersion),
          useValue: versionRepository,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(SettingsService);
  });

  it('merges stored values over the defaults', async () => {
    const settings = await service.getSettings('t1');
    expect(settings).toMatchObject({
      storeName: 'Shop',
      maxDiscountPercent: 15,
      currencyCode: 'USD',
      offlineLeaseHours: 24,
    });
  });

  it('caches per store until invalidated', async () => {
    await service.getSettings('t1');
    await service.getSettings('t1');
    expect(tenantRepository.findOneOrFail).toHaveBeenCalledTimes(1);
    service.invalidate('t1');
    await service.getSettings('t1');
    expect(tenantRepository.findOneOrFail).toHaveBeenCalledTimes(2);
  });

  it('applies a scheduled change once it is due, and audits it', async () => {
    versions = [
      {
        id: 'v2',
        version: 2,
        effectiveFrom: new Date(Date.now() - 1000),
        changes: { maxDiscountPercent: 30 },
        changedKeys: ['maxDiscountPercent'],
        appliedAt: null,
        cancelledAt: null,
        actorId: 'u1',
      },
    ];
    const settings = await service.getSettings('t1');
    expect(settings.maxDiscountPercent).toBe(30);
    expect(versions[0].appliedAt).toBeInstanceOf(Date);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'settings.scheduled_applied',
        actorId: 'u1',
      }),
      manager,
    );
  });

  it('leaves a future change waiting', async () => {
    versions = [
      {
        id: 'v2',
        version: 2,
        effectiveFrom: new Date(Date.now() + 3600_000),
        changes: { maxDiscountPercent: 30 },
        changedKeys: ['maxDiscountPercent'],
        appliedAt: null,
        cancelledAt: null,
      },
    ];
    expect((await service.getSettings('t1')).maxDiscountPercent).toBe(15);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });
});
