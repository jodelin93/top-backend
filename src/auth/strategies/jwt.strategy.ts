import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { User, UserStatus } from '../../database/entities/user.entity';
import {
  TenantMembership,
  MembershipStatus,
} from '../../database/entities/tenant-membership.entity';
import { TenantRole } from '../../database/entities/tenant-role.entity';
import { TenantStatus } from '../../database/entities/tenant.entity';
import { resolvePermissions } from '../../roles/role-permissions';
import { requestContext } from '../../common/context/request-context';
import type { Permission } from '../permissions';
import { JwtPayload } from '../auth.service';
import { getJwtSecret } from '../../config/jwt.config';
import { SessionsService } from '../../sessions/sessions.service';
import { SettingsService } from '../../settings/settings.service';
import { requiresMfaSetup } from '../mfa-policy';
import { membershipBranchIds } from '../branch-scope';

// Authenticated user as attached to the request, with the active tenant, role and permissions resolved
export type AuthUser = User & {
  tenantId: string | null;
  role: string | null;
  permissions: Permission[];
  // Branches the user may work in: null = every branch (owners always)
  branchIds: string[] | null;
  // Session (JWT sid) behind the token; null for tokens issued before sessions existed
  sessionId?: string | null;
  // Store policy requires two-factor setup before anything else (see JwtAuthGuard)
  mfaSetupRequired?: boolean;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(TenantMembership)
    private membershipRepository: Repository<TenantMembership>,
    @InjectRepository(TenantRole)
    private roleRepository: Repository<TenantRole>,
    private configService: ConfigService,
    private sessionsService: SessionsService,
    private settingsService: SettingsService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: getJwtSecret(configService),
    });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    const { sub: userId, mfaVerified } = payload;

    // Only session access tokens sign a user in: approval tokens (typ 'approval')
    // share the signing key and name the approver as sub, and the password step's
    // temporary MFA token has no session — neither may be used as a bearer token.
    if ((payload as { typ?: unknown }).typ !== undefined || !payload.sid) {
      throw new UnauthorizedException('Invalid token');
    }

    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('User not found');
    }

    // If user has MFA enabled, ensure the token has MFA verified
    if (user.mfaEnabled && !mfaVerified) {
      throw new UnauthorizedException('MFA verification required');
    }

    // Revoked or expired session (logout, "sign out everywhere", suspension...)
    const status = await this.sessionsService.check(payload.sid, userId);
    if (status !== 'active') {
      throw new UnauthorizedException('Your session has ended. Sign in again.');
    }

    // Active store: the one in the token, else the first active membership
    const membership = await this.membershipRepository.findOne({
      where: {
        userId,
        status: MembershipStatus.ACTIVE,
        ...(payload.tid && { tenantId: payload.tid }),
      },
      relations: { tenant: true },
      order: { joinedAt: 'ASC' },
    });
    if (payload.tid && !membership) {
      throw new UnauthorizedException(
        'You no longer have access to this store',
      );
    }
    // A suspended store is closed to everyone, whatever tokens are out there
    if (membership && membership.tenant?.status !== TenantStatus.ACTIVE) {
      throw new UnauthorizedException('This store is not active');
    }

    const role = membership
      ? await this.roleRepository.findOne({
          where: { tenantId: membership.tenantId, key: membership.role },
        })
      : null;
    const permissions = resolvePermissions(membership?.role, role);
    const branchIds = membershipBranchIds(membership);

    const mfaSetupRequired =
      payload.scope === 'mfa_setup' ||
      (!!membership &&
        !user.mfaEnabled &&
        requiresMfaSetup(
          user,
          permissions,
          await this.settingsService.getSettings(membership.tenantId),
        ));

    requestContext.set({
      userId: user.id,
      tenantId: membership?.tenantId ?? null,
      sessionId: payload.sid,
      permissions,
      branchIds,
    });

    return Object.assign(user, {
      tenantId: membership?.tenantId ?? null,
      role: membership?.role ?? null,
      permissions,
      branchIds,
      sessionId: payload.sid ?? null,
      mfaSetupRequired,
    });
  }
}
