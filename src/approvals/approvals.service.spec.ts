import { JwtService } from '@nestjs/jwt';
import { DataSource, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserStatus } from '../database/entities/user.entity';
import { TenantMembership } from '../database/entities/tenant-membership.entity';
import { TenantRole } from '../database/entities/tenant-role.entity';
import { AuditService } from '../audit/audit.service';
import { requestContext } from '../common/context/request-context';
import { APPROVAL_TTL_SECONDS, ApprovalsService } from './approvals.service';
import {
  approvalAction,
  beginApprovalScope,
  currentApprovalScope,
  normaliseAction,
} from './approval-scope';
import { ApprovalUsesInterceptor } from './approval-uses.interceptor';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { lastValueFrom, throwError } from 'rxjs';

const requester = { id: 'cashier', tenantId: 't1' };

describe('approvalAction', () => {
  it('strips the API prefix and query', () => {
    expect(approvalAction('post', '/api/v1/sales/s1/void?x=1')).toEqual({
      action: 'POST /sales/s1/void',
      readOnly: false,
    });
  });

  it('treats a quote or preview as a read of the command it previews', () => {
    expect(approvalAction('POST', '/api/v1/sales/quote')).toEqual({
      action: 'POST /sales',
      readOnly: true,
    });
    expect(approvalAction('POST', '/api/v1/shifts/s1/preview-close')).toEqual({
      action: 'POST /shifts/s1/close',
      readOnly: true,
    });
    expect(approvalAction('GET', '/api/v1/returns/lookup')).toMatchObject({
      readOnly: true,
    });
  });

  it('normalises client-sent actions', () => {
    expect(normaliseAction('post /sales/quote')).toBe('POST /sales');
    expect(normaliseAction('nonsense')).toBeNull();
  });
});

describe('ApprovalsService', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const used = new Set<string>();
  const dataSource = {
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT')) {
        return Promise.resolve(used.has(params[0] as string) ? [{}] : []);
      }
      if (sql.startsWith('INSERT')) {
        const jti = params[0] as string;
        if (used.has(jti)) return Promise.resolve([]);
        used.add(jti);
        return Promise.resolve([{ id: jti }]);
      }
      if (sql.startsWith('DELETE')) {
        (params[0] as string[]).forEach((j) => used.delete(j));
        return Promise.resolve([[], 0]);
      }
      throw new Error(`unexpected SQL ${sql}`);
    }),
  };
  const manager = {
    id: 'manager',
    email: 'boss@example.com',
    status: UserStatus.ACTIVE,
    mfaEnabled: false,
    passwordHash: bcrypt.hashSync('secret', 4),
  };
  const users = {
    findOne: jest.fn(() => Promise.resolve(manager)),
    // Lockout counters (auth/credentials)
    query: jest.fn(() => Promise.resolve([])),
  };
  const memberships = {
    findOne: jest.fn(() => Promise.resolve({ role: 'manager' })),
    exists: jest.fn(() => Promise.resolve(true)),
  };
  const audit = { record: jest.fn() };
  const service = new ApprovalsService(
    users as unknown as Repository<User>,
    memberships as unknown as Repository<TenantMembership>,
    {
      findOne: jest.fn(() => Promise.resolve(null)),
    } as unknown as Repository<TenantRole>,
    jwt,
    audit as unknown as AuditService,
    dataSource as unknown as DataSource,
  );

  const approve = (action = 'POST /sales/s1/void', password = 'secret') =>
    service.approve(requester, {
      permission: 'sales.void',
      approverEmail: manager.email,
      password,
      action,
    });

  // Runs `work` as a request to `method url`, like PermissionsGuard sets it up
  const inRequest = <T>(method: string, url: string, work: () => Promise<T>) =>
    requestContext.run({}, () => {
      beginApprovalScope(method, url);
      return work();
    });

  beforeEach(() => {
    used.clear();
    dataSource.query.mockClear();
    users.query.mockClear();
    audit.record.mockClear();
    memberships.exists.mockResolvedValue(true);
  });

  it('issues a short-lived token with a unique id', async () => {
    const a = await approve();
    const b = await approve();
    expect(a.expiresIn).toBe(APPROVAL_TTL_SECONDS);
    expect(APPROVAL_TTL_SECONDS).toBe(120);
    const pa = jwt.decode<{ jti: string }>(a.approvalToken);
    const pb = jwt.decode<{ jti: string }>(b.approvalToken);
    expect(pa.jti).toBeTruthy();
    expect(pa.jti).not.toBe(pb.jti);
  });

  it('is single use: a second command with the same token is refused', async () => {
    const { approvalToken } = await approve();
    const first = await inRequest('POST', '/api/v1/sales/s1/void', () =>
      service.verify(approvalToken, 'sales.void', requester),
    );
    expect(first).toBe('manager');
    const again = await inRequest('POST', '/api/v1/sales/s1/void', () =>
      service.verify(approvalToken, 'sales.void', requester),
    );
    expect(again).toBeNull();
  });

  it('accepts the token again within the request that claimed it', async () => {
    const { approvalToken } = await approve();
    await inRequest('POST', '/api/v1/sales/s1/void', async () => {
      expect(await service.verify(approvalToken, 'sales.void', requester)).toBe(
        'manager',
      );
      expect(await service.verify(approvalToken, 'sales.void', requester)).toBe(
        'manager',
      );
    });
  });

  it('does not use the token up on a quote, so the sale can use it', async () => {
    const { approvalToken } = await approve('POST /api/v1/sales');
    for (let i = 0; i < 2; i++) {
      expect(
        await inRequest('POST', '/api/v1/sales/quote', () =>
          service.verify(approvalToken, 'sales.void', requester),
        ),
      ).toBe('manager');
    }
    expect(used.size).toBe(0);
    expect(
      await inRequest('POST', '/api/v1/sales', () =>
        service.verify(approvalToken, 'sales.void', requester),
      ),
    ).toBe('manager');
    expect(used.size).toBe(1);
    // Used: not even a quote accepts it any more
    expect(
      await inRequest('POST', '/api/v1/sales/quote', () =>
        service.verify(approvalToken, 'sales.void', requester),
      ),
    ).toBeNull();
  });

  it('refuses a token issued for another action', async () => {
    const { approvalToken } = await approve('POST /sales/s1/void');
    expect(
      await inRequest('POST', '/api/v1/sales/s2/void', () =>
        service.verify(approvalToken, 'sales.void', requester),
      ),
    ).toBeNull();
    expect(
      await inRequest('POST', '/api/v1/sales/s1/void', () =>
        service.verify(approvalToken, 'sales.void', requester),
      ),
    ).toBe('manager');
  });

  it('refuses another permission or requester', async () => {
    const { approvalToken } = await approve();
    expect(
      await service.verify(approvalToken, 'sales.refund', requester),
    ).toBeNull();
    expect(
      await service.verify(approvalToken, 'sales.void', {
        id: 'someone-else',
        tenantId: 't1',
      }),
    ).toBeNull();
  });

  it('gives the token back when the request fails (interceptor)', async () => {
    const { approvalToken } = await approve();
    const interceptor = new ApprovalUsesInterceptor(service);
    const context = { getType: () => 'http' } as ExecutionContext;
    await inRequest('POST', '/api/v1/sales/s1/void', async () => {
      await service.verify(approvalToken, 'sales.void', requester);
      expect(used.size).toBe(1);
      const error = await lastValueFrom(
        interceptor.intercept(context, {
          handle: () =>
            throwError(
              () =>
                new ForbiddenException({
                  message: 'needs another approval',
                  missingPermissions: ['sales.refund.any_method'],
                  approvable: true,
                }),
            ),
        }),
      ).catch((e: unknown) => e);
      expect(used.size).toBe(0);
      expect(currentApprovalScope()?.claimed).toEqual([]);
      // The 403 says which action to ask the approval for
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        action: 'POST /sales/s1/void',
      });
    });
    // So the retry can use it
    expect(
      await inRequest('POST', '/api/v1/sales/s1/void', () =>
        service.verify(approvalToken, 'sales.void', requester),
      ),
    ).toBe('manager');
  });

  it('requires the action the approval is for', async () => {
    await expect(approve('nonsense')).rejects.toThrow(/METHOD \/path/);
    // A token without an action (issued before they were required) is refused
    const legacy = await jwt.signAsync({
      typ: 'approval',
      jti: '00000000-0000-4000-8000-000000000001',
      sub: 'manager',
      requesterId: requester.id,
      tenantId: requester.tenantId,
      permission: 'sales.void',
    });
    expect(
      await inRequest('POST', '/api/v1/sales/s1/void', () =>
        service.verify(legacy, 'sales.void', requester),
      ),
    ).toBeNull();
  });

  it('only accepts approvers of this store, with one answer for every failure', async () => {
    memberships.exists.mockResolvedValue(false);
    const outsider = await approve().catch((e: Error) => e);
    memberships.exists.mockResolvedValue(true);
    const wrongPassword = await approve(undefined, 'nope').catch(
      (e: Error) => e,
    );
    expect((outsider as Error).message).toBe(
      'Approver email or password is incorrect',
    );
    expect((wrongPassword as Error).message).toBe((outsider as Error).message);
    // Only the store member's wrong password counts towards their lockout
    const counted = users.query.mock.calls.filter((c) =>
      String((c as unknown[])[0]).includes('"failedLoginCount" + 1'),
    );
    expect(counted).toHaveLength(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approval.denied' }),
    );
  });

  it('refuses a locked approver account', async () => {
    users.findOne.mockResolvedValueOnce({
      ...manager,
      lockedUntil: new Date(Date.now() + 60_000),
    } as never);
    await expect(approve()).rejects.toThrow(/locked/);
  });
});
