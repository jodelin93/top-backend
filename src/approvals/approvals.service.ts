import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { User, UserStatus } from '../database/entities/user.entity';
import {
  MembershipStatus,
  TenantMembership,
} from '../database/entities/tenant-membership.entity';
import { TenantRole } from '../database/entities/tenant-role.entity';
import { isPermission, Permission } from '../auth/permissions';
import { resolvePermissions } from '../roles/role-permissions';
import { AuditService } from '../audit/audit.service';
import { RequestApprovalDto } from './approvals.dto';
import { currentApprovalScope, normaliseAction } from './approval-scope';
import {
  assertNotLocked,
  clearFailedAttempts,
  consumeTotp,
  passwordMatches,
  recordFailedAttempt,
} from '../auth/credentials';

// Approvals are for one action right now, not a standing grant
export const APPROVAL_TTL_SECONDS = 120;

interface ApprovalPayload {
  typ: 'approval';
  jti: string; // single use: recorded in approval_uses once used
  sub: string; // approver
  requesterId: string;
  tenantId: string;
  permission: Permission;
  // "METHOD /path" the approval is for (see approvalAction); tokens without
  // one (issued before actions were required) are refused
  action?: string;
}

/**
 * Manager override (separation of duties): a user without a permission asks
 * someone who has it to authorise one action with their own credentials.
 * The result is a short-lived, single-use token bound to the requester, store,
 * permission and action, sent back as the X-Approval-Token header.
 *
 * Use: verify() checks a token for the current request (the scope PermissionsGuard
 * records). On a command it claims the token (a row in approval_uses, unique jti),
 * so it cannot be used again, even concurrently; ApprovalUsesInterceptor gives the
 * claim back if the request then fails, so only an action that went through uses it
 * up. Read-only requests (GET, a quote or preview of the command) only check it.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @InjectRepository(User) private userRepository: Repository<User>,
    @InjectRepository(TenantMembership)
    private membershipRepository: Repository<TenantMembership>,
    @InjectRepository(TenantRole)
    private roleRepository: Repository<TenantRole>,
    private jwtService: JwtService,
    private auditService: AuditService,
    private dataSource: DataSource,
  ) {}

  async approve(
    requester: { id: string; tenantId: string },
    dto: RequestApprovalDto,
  ) {
    if (!isPermission(dto.permission)) {
      throw new ForbiddenException('Unknown permission');
    }

    const deny = async (reason: string, approverId?: string) => {
      await this.auditService.record({
        tenantId: requester.tenantId,
        action: 'approval.denied',
        entityType: 'approval',
        entityId: dto.permission,
        ...(approverId && { approverId }),
        metadata: { approverEmail: dto.approverEmail, reason },
      });
    };
    // Every credential failure gets the same answer, so this can't be used to
    // test passwords or learn which accounts exist, belong to the store or use
    // two-factor.
    const incorrect = () =>
      new UnauthorizedException('Approver email or password is incorrect');

    const action = normaliseAction(dto.action);
    if (!action) {
      throw new BadRequestException(
        'action must look like "METHOD /path", e.g. "POST /sales"',
      );
    }

    // Only a member of this store can approve: accounts of other stores are
    // never looked at (no password oracle across stores)
    const found = await this.userRepository.findOne({
      where: { email: dto.approverEmail.trim().toLowerCase() },
    });
    const member =
      found &&
      (await this.membershipRepository.exists({
        where: {
          userId: found.id,
          tenantId: requester.tenantId,
          status: MembershipStatus.ACTIVE,
        },
      }));
    const approver = member ? found : null;
    assertNotLocked(approver);
    const passwordOk = await passwordMatches(approver, dto.password);
    if (!approver || approver.status !== UserStatus.ACTIVE || !passwordOk) {
      if (approver && !passwordOk) {
        await recordFailedAttempt(this.userRepository, approver.id);
      }
      await deny('invalid credentials');
      throw incorrect();
    }

    if (approver.id === requester.id) {
      await deny('self approval', approver.id);
      throw new ForbiddenException(
        'An approval must come from a different person',
      );
    }

    if (
      approver.mfaEnabled &&
      !(await consumeTotp(this.userRepository, approver, dto.mfaCode))
    ) {
      await recordFailedAttempt(this.userRepository, approver.id);
      await deny('invalid two-factor code', approver.id);
      throw new UnauthorizedException(
        "The approver's two-factor code is missing or invalid",
      );
    }
    await clearFailedAttempts(this.userRepository, approver.id);

    const permissions = await this.permissionsOf(
      approver.id,
      requester.tenantId,
    );
    if (!permissions.includes(dto.permission)) {
      await deny('permission not held', approver.id);
      throw new ForbiddenException(
        'The approver is not allowed to authorise this action',
      );
    }

    const payload: ApprovalPayload = {
      typ: 'approval',
      jti: randomUUID(),
      sub: approver.id,
      requesterId: requester.id,
      tenantId: requester.tenantId,
      permission: dto.permission,
      action,
    };
    await this.auditService.record({
      tenantId: requester.tenantId,
      action: 'approval.granted',
      entityType: 'approval',
      entityId: dto.permission,
      approverId: approver.id,
      metadata: { jti: payload.jti, for: action },
    });

    return {
      approvalToken: await this.jwtService.signAsync(payload, {
        expiresIn: APPROVAL_TTL_SECONDS,
      }),
      expiresIn: APPROVAL_TTL_SECONDS,
      approver: {
        id: approver.id,
        name:
          [approver.firstName, approver.lastName].filter(Boolean).join(' ') ||
          approver.email,
      },
    };
  }

  /**
   * Returns the approver's id if the token authorises `permission` for this requester
   * and the current request, else null. On a command (not a read or a quote/preview)
   * the token is used up; a token already used, or issued for another action, fails.
   */
  async verify(
    token: string,
    permission: Permission,
    requester: { id: string; tenantId: string | null },
  ): Promise<string | null> {
    let payload: ApprovalPayload;
    try {
      payload = await this.jwtService.verifyAsync<ApprovalPayload>(token);
    } catch {
      return null;
    }
    const matches =
      payload.typ === 'approval' &&
      !!payload.jti &&
      payload.permission === permission &&
      payload.requesterId === requester.id &&
      payload.tenantId === requester.tenantId;
    if (!matches) return null;

    const scope = currentApprovalScope();
    // Bound to one action: a void approval can't be spent on another sale's void
    if (!payload.action || !scope || payload.action !== scope.action) {
      return null;
    }

    // The approver must still hold the permission (role may have changed since)
    const permissions = await this.permissionsOf(payload.sub, payload.tenantId);
    if (!permissions.includes(permission)) return null;

    // Already checked (and claimed if needed) earlier in this request
    if (scope?.claimed.includes(payload.jti)) return payload.sub;

    if (scope?.readOnly) {
      return (await this.isUsed(payload.jti)) ? null : payload.sub;
    }
    const claimed = await this.claim(payload, scope?.action ?? null);
    if (!claimed) return null;
    scope?.claimed.push(payload.jti);
    return payload.sub;
  }

  /**
   * Give back tokens claimed by a request that failed, so the approval can be
   * used for the retry
   */
  async release(jtis: string[]): Promise<void> {
    if (!jtis.length) return;
    await this.dataSource.query(
      `DELETE FROM approval_uses WHERE jti = ANY($1::uuid[])`,
      [jtis],
    );
  }

  private async isUsed(jti: string): Promise<boolean> {
    const rows = await this.dataSource.query<unknown[]>(
      `SELECT 1 FROM approval_uses WHERE jti = $1`,
      [jti],
    );
    return rows.length > 0;
  }

  // Record the use; false when the token was already used (unique jti)
  private async claim(
    payload: ApprovalPayload,
    action: string | null,
  ): Promise<boolean> {
    const rows = await this.dataSource.query<unknown[]>(
      `INSERT INTO approval_uses (jti, "tenantId", "approverId", "requesterId", permission, action)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (jti) DO NOTHING
       RETURNING id`,
      [
        payload.jti,
        payload.tenantId,
        payload.sub,
        payload.requesterId,
        payload.permission,
        action?.slice(0, 300) ?? null,
      ],
    );
    return rows.length > 0;
  }

  private async permissionsOf(
    userId: string,
    tenantId: string,
  ): Promise<Permission[]> {
    const membership = await this.membershipRepository.findOne({
      where: { userId, tenantId, status: MembershipStatus.ACTIVE },
    });
    if (!membership) return [];
    const role = await this.roleRepository.findOne({
      where: { tenantId, key: membership.role },
    });
    return resolvePermissions(membership.role, role);
  }
}
