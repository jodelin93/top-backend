import { ForbiddenException } from '@nestjs/common';
import { resolveDistinctApprover } from './separation-of-duties';
import { requestContext } from '../common/context/request-context';
import type { ApprovalsService } from '../approvals/approvals.service';
import type { AuthUser } from '../auth/strategies/jwt.strategy';

describe('resolveDistinctApprover', () => {
  const user = { id: 'creator', tenantId: 't' } as AuthUser;
  const base = {
    user,
    permission: 'purchasing.approve' as const,
    message: 'someone else must approve',
  };

  it('lets a different user with the permission approve', async () => {
    const approvalsService = { verify: jest.fn() };
    await expect(
      resolveDistinctApprover({
        ...base,
        approvalsService: approvalsService as unknown as ApprovalsService,
        user: { id: 'manager', tenantId: 't' } as AuthUser,
        otherPartyId: 'creator',
      }),
    ).resolves.toBe('manager');
  });

  it('refuses self-approval with an approvable 403', async () => {
    const approvalsService = { verify: jest.fn() };
    const attempt = resolveDistinctApprover({
      ...base,
      approvalsService: approvalsService as unknown as ApprovalsService,
      otherPartyId: 'creator',
    });
    await expect(attempt).rejects.toThrow(ForbiddenException);
    await attempt.catch((error: ForbiddenException) =>
      expect(error.getResponse()).toMatchObject({
        missingPermissions: ['purchasing.approve'],
        approvable: true,
      }),
    );
  });

  it("accepts another person's approval token for the creator", async () => {
    const approvalsService = { verify: jest.fn().mockResolvedValue('boss') };
    await expect(
      requestContext.run({}, () =>
        resolveDistinctApprover({
          ...base,
          approvalsService: approvalsService as unknown as ApprovalsService,
          otherPartyId: 'creator',
          approvalToken: 'token',
        }),
      ),
    ).resolves.toBe('boss');
    expect(approvalsService.verify).toHaveBeenCalledWith(
      'token',
      'purchasing.approve',
      user,
    );
  });

  it('uses the approver from the guard when the user lacked the permission', async () => {
    const approvalsService = { verify: jest.fn() };
    await expect(
      requestContext.run({ approverId: 'creator' }, () =>
        resolveDistinctApprover({
          ...base,
          approvalsService: approvalsService as unknown as ApprovalsService,
          user: { id: 'clerk', tenantId: 't' } as AuthUser,
          otherPartyId: 'creator',
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
