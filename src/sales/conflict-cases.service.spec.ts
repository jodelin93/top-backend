import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import {
  ConflictCase,
  ConflictCaseStatus,
  ConflictCaseType,
} from '../database/entities/conflict-case.entity';
import {
  caseTypesFor,
  CASE_PERMISSIONS,
  ConflictCasesService,
  openConflictCase,
} from './conflict-cases.service';
import { ListConflictCasesQueryDto } from './sales.dto';
import type { AuthUser } from '../auth/strategies/jwt.strategy';

describe('ConflictCasesService', () => {
  const manager = {
    findOne: jest.fn(),
    create: jest.fn((_entity: unknown, data: object) => data),
    save: jest.fn((data: object) => Promise.resolve(data)),
  };
  const dataSource = {
    transaction: jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager),
    ),
  };
  const audit = { record: jest.fn() };
  const service = new ConflictCasesService(
    dataSource as unknown as DataSource,
    audit as unknown as AuditService,
  );

  const stock = { id: 'u1', permissions: ['inventory.adjust'] } as Pick<
    AuthUser,
    'id' | 'permissions'
  >;
  const reviewer = { id: 'u2', permissions: ['sales.review'] } as Pick<
    AuthUser,
    'id' | 'permissions'
  >;

  beforeEach(() => jest.clearAllMocks());

  it('opens a case in the caller transaction', async () => {
    await openConflictCase(manager as unknown as EntityManager, {
      tenantId: 't1',
      type: ConflictCaseType.OFFLINE_OVERSELL,
      saleId: 's1',
      details: { lines: [] },
    });
    expect(manager.create).toHaveBeenCalledWith(ConflictCase, {
      tenantId: 't1',
      type: 'offline_oversell',
      status: 'open',
      saleId: 's1',
      deviceId: null,
      details: { lines: [] },
    });
  });

  it('resolves an open case with a note, on record', async () => {
    manager.findOne.mockResolvedValue({
      id: 'c1',
      tenantId: 't1',
      type: ConflictCaseType.OFFLINE_OVERSELL,
      status: ConflictCaseStatus.OPEN,
      saleId: 's1',
    });
    const resolved = await service.resolve('t1', stock, 'c1', {
      status: 'resolved',
      note: ' Counted the shelf ',
    });
    expect(resolved).toMatchObject({
      status: 'resolved',
      resolvedById: 'u1',
      resolutionNote: 'Counted the shelf',
    });
    expect(resolved.resolvedAt).toBeInstanceOf(Date);
    expect(manager.findOne).toHaveBeenCalledWith(ConflictCase, {
      where: { id: 'c1', tenantId: 't1' },
      lock: { mode: 'pessimistic_write' },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'conflict_case.resolved' }),
      manager,
    );
  });

  it('refuses a case that is closed or belongs to another store', async () => {
    manager.findOne.mockResolvedValueOnce({
      id: 'c1',
      type: ConflictCaseType.OFFLINE_OVERSELL,
      status: ConflictCaseStatus.DISMISSED,
    });
    await expect(
      service.resolve('t1', stock, 'c1', { status: 'resolved', note: 'x' }),
    ).rejects.toThrow(ConflictException);
    manager.findOne.mockResolvedValueOnce(null);
    await expect(
      service.resolve('t1', stock, 'c1', { status: 'dismissed', note: 'x' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('lets the review queue filter on every case type', () => {
    for (const type of Object.values(ConflictCaseType)) {
      const dto = plainToInstance(ListConflictCasesQueryDto, { type });
      expect(validateSync(dto)).toEqual([]);
    }
    const bad = plainToInstance(ListConflictCasesQueryDto, { type: 'nope' });
    expect(validateSync(bad)).toHaveLength(1);
  });

  it('lets each kind of case be closed only by its own people', async () => {
    const open = (type: ConflictCaseType) =>
      manager.findOne.mockResolvedValueOnce({
        id: 'c1',
        tenantId: 't1',
        type,
        status: ConflictCaseStatus.OPEN,
      });
    for (const type of [
      ConflictCaseType.OFFLINE_PRICE,
      ConflictCaseType.OFFLINE_LEASE,
      ConflictCaseType.LATE_SHIFT,
      ConflictCaseType.OFFLINE_NO_SHIFT,
    ]) {
      open(type);
      await expect(
        service.resolve('t1', stock, 'c1', { status: 'dismissed', note: 'x' }),
      ).rejects.toThrow(ForbiddenException);
    }
    open(ConflictCaseType.OFFLINE_OVERSELL);
    await expect(
      service.resolve('t1', reviewer, 'c1', {
        status: 'dismissed',
        note: 'x',
      }),
    ).rejects.toThrow(ForbiddenException);
    open(ConflictCaseType.OFFLINE_PRICE);
    await expect(
      service.resolve('t1', reviewer, 'c1', { status: 'resolved', note: 'ok' }),
    ).resolves.toMatchObject({ status: 'resolved' });
    expect(manager.save).toHaveBeenCalledTimes(1);
  });

  it('maps every case type to who works it, and lists only those', () => {
    for (const type of Object.values(ConflictCaseType)) {
      expect(CASE_PERMISSIONS[type].length).toBeGreaterThan(0);
    }
    expect(caseTypesFor(['inventory.adjust'])).toEqual([
      ConflictCaseType.OFFLINE_OVERSELL,
    ]);
    expect(caseTypesFor(['shifts.manage']).sort()).toEqual(
      [ConflictCaseType.LATE_SHIFT, ConflictCaseType.OFFLINE_NO_SHIFT].sort(),
    );
    expect(caseTypesFor(['sales.review'])).not.toContain(
      ConflictCaseType.OFFLINE_OVERSELL,
    );
    expect(caseTypesFor([])).toEqual([]);
  });
});
