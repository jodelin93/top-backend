import type { ApprovalsService } from '../approvals/approvals.service';
import type { Permission } from '../auth/permissions';
import type { AuthUser } from '../auth/strategies/jwt.strategy';

/**
 * Who authorises an action that needs `permission` only in some cases
 * (over-receipt beyond the tolerance, ...): the user when they hold it, else the
 * owner of a valid manager approval token (X-Approval-Token), else null. The
 * caller throws approvalRequired() when the case arises and nobody authorised it.
 */
export async function resolveOptionalApprover(
  approvalsService: ApprovalsService | undefined,
  user: Pick<AuthUser, 'id' | 'tenantId' | 'permissions'>,
  permission: Permission,
  approvalToken?: string,
): Promise<string | null> {
  if (user.permissions?.includes(permission)) return user.id;
  if (!approvalToken || !approvalsService) return null;
  return approvalsService.verify(approvalToken, permission, user);
}
