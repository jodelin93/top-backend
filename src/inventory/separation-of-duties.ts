import { ForbiddenException } from '@nestjs/common';
import type { ApprovalsService } from '../approvals/approvals.service';
import type { Permission } from '../auth/permissions';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { requestContext } from '../common/context/request-context';

/**
 * Separation of duties for approvals (PO approval, count variance approval):
 * the approving person must differ from `otherPartyId` (creator / counter).
 *
 * - A user holding the permission approves as themselves, unless they are the
 *   other party. Then they need a manager-override token from someone else.
 * - A user without the permission got through PermissionsGuard with an approval
 *   token: the approver is the token's owner.
 *
 * The 403 has the same shape as PermissionsGuard's (missingPermissions +
 * approvable), so the frontend's useApproval() asks for another person's
 * credentials and retries with the X-Approval-Token header.
 */
export async function resolveDistinctApprover(options: {
  approvalsService: ApprovalsService;
  user: AuthUser;
  permission: Permission;
  otherPartyId: string | null;
  approvalToken?: string;
  message: string;
}): Promise<string> {
  const { approvalsService, user, permission, otherPartyId, approvalToken } =
    options;
  const approverId = requestContext.get()?.approverId ?? user.id;
  if (approverId !== otherPartyId) {
    return approverId;
  }
  // The requester is the other party but holds the permission: accept another
  // person's approval token for this one action
  if (approvalToken && approverId === user.id) {
    const tokenApprover = await approvalsService.verify(
      approvalToken,
      permission,
      user,
    );
    if (tokenApprover && tokenApprover !== otherPartyId) {
      requestContext.set({ approverId: tokenApprover });
      return tokenApprover;
    }
  }
  throw new ForbiddenException({
    message: options.message,
    error: 'Forbidden',
    missingPermissions: [permission],
    approvable: true,
  });
}

/**
 * Approver for an action that only sometimes needs a permission (e.g. an
 * over-receipt above the tolerance): the user when they hold it, the owner of
 * a valid X-Approval-Token for it, else null (the service then answers 403
 * with approvable: true when the approval turns out to be needed).
 */
export async function optionalApprover(options: {
  approvalsService: ApprovalsService;
  user: AuthUser;
  permission: Permission;
  approvalToken?: string;
}): Promise<string | null> {
  const { approvalsService, user, permission, approvalToken } = options;
  if (user.permissions?.includes(permission)) return user.id;
  if (!approvalToken) return null;
  const approverId = await approvalsService.verify(
    approvalToken,
    permission,
    user,
  );
  if (approverId) requestContext.set({ approverId });
  return approverId;
}
