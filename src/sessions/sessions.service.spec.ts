import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserSession } from './user-session.entity';
import { TenantMembership } from '../database/entities/tenant-membership.entity';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from './sessions.service';
import {
  SESSION_TOUCH_INTERVAL_MS,
  sessionStatus,
  shouldTouch,
} from './session-state';

describe('session rules', () => {
  const now = new Date('2026-09-24T12:00:00Z');

  it('is active until it expires or is revoked', () => {
    const expiresAt = new Date('2026-09-24T13:00:00Z');
    expect(sessionStatus({ revokedAt: null, expiresAt }, now)).toBe('active');
    expect(
      sessionStatus(
        { revokedAt: new Date('2026-09-24T11:00:00Z'), expiresAt },
        now,
      ),
    ).toBe('revoked');
    expect(sessionStatus({ revokedAt: null, expiresAt: now }, now)).toBe(
      'expired',
    );
  });

  it('throttles lastSeenAt writes', () => {
    expect(shouldTouch(new Date(now.getTime() - 1000), now)).toBe(false);
    expect(
      shouldTouch(new Date(now.getTime() - SESSION_TOUCH_INTERVAL_MS), now),
    ).toBe(true);
  });
});

describe('SessionsService', () => {
  let service: SessionsService;
  const rows = new Map<string, Partial<UserSession>>();
  const qb = {
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    whereInIds: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    execute: jest.fn(),
  };
  const repo = {
    findOne: jest.fn(({ where }: { where: { id: string; userId?: string } }) =>
      Promise.resolve(rows.get(where.id) ?? null),
    ),
    find: jest.fn(() =>
      Promise.resolve(
        [...rows.values()]
          .filter((r) => !r.revokedAt)
          .map((r) => ({ id: r.id })),
      ),
    ),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    create: jest.fn((v: object) => v),
    save: jest.fn((v: object) => Promise.resolve(v)),
    createQueryBuilder: jest.fn(() => qb),
  };
  const audit = { record: jest.fn() };
  const memberships = { findOne: jest.fn() };

  const session = (id: string, extra: Partial<UserSession> = {}) =>
    rows.set(id, {
      id,
      userId: 'u1',
      tenantId: 't1',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3600_000),
      lastSeenAt: new Date(),
      ...extra,
    });

  beforeEach(async () => {
    rows.clear();
    jest.clearAllMocks();
    // Revocation marks the rows (what the UPDATE would do)
    qb.whereInIds.mockImplementation((ids: string[]) => {
      ids.forEach((id) => {
        const row = rows.get(id);
        if (row) row.revokedAt = new Date();
      });
      return qb;
    });
    const module = await Test.createTestingModule({
      providers: [
        SessionsService,
        { provide: getRepositoryToken(UserSession), useValue: repo },
        {
          provide: getRepositoryToken(TenantMembership),
          useValue: memberships,
        },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(SessionsService);
  });

  it('accepts an active session and caches the lookup', async () => {
    session('s1');
    await expect(service.check('s1', 'u1')).resolves.toBe('active');
    await expect(service.check('s1', 'u1')).resolves.toBe('active');
    expect(repo.findOne).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown sessions and sessions of another user', async () => {
    await expect(service.check('missing', 'u1')).resolves.toBe('revoked');
    session('s2');
    await expect(service.check('s2', 'someone-else')).resolves.toBe('revoked');
  });

  it('rejects expired sessions', async () => {
    session('s3', { expiresAt: new Date(Date.now() - 1000) });
    await expect(service.check('s3', 'u1')).resolves.toBe('expired');
  });

  it('revocation takes effect at once, even for a cached session', async () => {
    session('s4');
    await expect(service.check('s4', 'u1')).resolves.toBe('active');
    await service.revokeOwn('u1', 's4', 'logout', 't1');
    await expect(service.check('s4', 'u1')).resolves.toBe('revoked');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'session.revoked', entityId: 's4' }),
    );
  });

  it('"sign out everywhere else" keeps the current session', async () => {
    session('current');
    session('other');
    repo.find.mockImplementationOnce(() => Promise.resolve([{ id: 'other' }]));
    await expect(service.revokeOthers('u1', 'current', 't1')).resolves.toBe(1);
    expect(repo.find).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: expect.anything() as unknown,
        }) as object,
      }),
    );
    await expect(service.check('current', 'u1')).resolves.toBe('active');
    await expect(service.check('other', 'u1')).resolves.toBe('revoked');
  });

  it('an admin can only revoke sessions of a member of their store', async () => {
    memberships.findOne.mockResolvedValueOnce(null);
    await expect(service.revokeMember('t1', 'u9')).rejects.toThrow(
      'Member not found',
    );
    memberships.findOne.mockResolvedValueOnce({ userId: 'u1' });
    session('s5');
    await expect(service.revokeMember('t1', 'u1')).resolves.toBe(1);
    expect(repo.find).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u1',
          tenantId: 't1',
        }) as object,
      }),
    );
  });
});
