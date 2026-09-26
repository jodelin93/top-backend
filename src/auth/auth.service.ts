import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as speakeasy from 'speakeasy';
import * as QRCode from 'qrcode';
import { User, UserStatus } from '../database/entities/user.entity';
import { TenantRole } from '../database/entities/tenant-role.entity';
import { TenantStatus } from '../database/entities/tenant.entity';
import { resolvePermissions } from '../roles/role-permissions';
import type { Permission } from './permissions';
import { membershipBranchIds } from './branch-scope';
import {
  TenantMembership,
  MembershipStatus,
} from '../database/entities/tenant-membership.entity';
import { SessionsService } from '../sessions/sessions.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';
import { requiresMfaSetup } from './mfa-policy';
import {
  assertNotLocked,
  clearFailedAttempts,
  consumeTotp,
  passwordMatches,
  recordFailedAttempt,
} from './credentials';

export interface JwtPayload {
  sub: string;
  email: string;
  mfaVerified?: boolean;
  // Session id (user_sessions.id); tokens issued before sessions existed have none
  sid?: string;
  // Active store; tokens without it use the user's first membership
  tid?: string;
  // 'mfa_setup': may only reach the two-factor setup endpoints
  scope?: 'mfa_setup';
  // Set on tokens that are not session access tokens ('mfa_pending': the
  // password step's temporary token, only good for /auth/mfa/verify)
  typ?: 'mfa_pending';
  exp?: number;
}

export interface UserInfo {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  mfaEnabled: boolean;
  tenantId: string | null;
  tenantName: string | null;
  role: string | null;
  roleName: string | null;
  permissions: Permission[];
  // Branches the user works in: null = every branch (spec §9)
  branchIds: string[] | null;
  // The store requires two-factor for this user's role and it isn't set up yet
  mfaSetupRequired: boolean;
}

export interface LoginResponse {
  accessToken: string;
  user: UserInfo;
  requiresMfa: boolean;
  // Signed in with a restricted token: set up two-factor at /account/security first
  mfaSetupRequired: boolean;
  // When the access token (and its session) expires
  expiresAt?: string;
}

export interface StoreOption {
  tenantId: string;
  name: string;
  slug: string;
  role: string;
  roleName: string;
  current: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectRepository(User)
    private userRepository: Repository<User>,
    @InjectRepository(TenantMembership)
    private membershipRepository: Repository<TenantMembership>,
    @InjectRepository(TenantRole)
    private roleRepository: Repository<TenantRole>,
    private jwtService: JwtService,
    private sessionsService: SessionsService,
    private settingsService: SettingsService,
    private auditService: AuditService,
    @Optional() private configService?: ConfigService,
  ) {}

  private readonly logger = new Logger(AuthService.name);

  /**
   * The user's active membership in `tenantId`, or their first active membership
   */
  async getActiveMembership(
    userId: string,
    tenantId?: string | null,
  ): Promise<TenantMembership | null> {
    return this.membershipRepository.findOne({
      where: {
        userId,
        status: MembershipStatus.ACTIVE,
        ...(tenantId && { tenantId }),
      },
      relations: { tenant: true },
      order: { joinedAt: 'ASC' },
    });
  }

  async getUserInfo(user: User, tenantId?: string | null): Promise<UserInfo> {
    const membership = await this.getActiveMembership(user.id, tenantId);
    const role = membership
      ? await this.roleRepository.findOne({
          where: { tenantId: membership.tenantId, key: membership.role },
        })
      : null;
    const permissions = resolvePermissions(membership?.role, role);
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      mfaEnabled: user.mfaEnabled,
      tenantId: membership?.tenantId ?? null,
      tenantName: membership?.tenant?.name ?? null,
      role: membership?.role ?? null,
      roleName: role?.name ?? membership?.role ?? null,
      permissions,
      branchIds: membershipBranchIds(membership),
      mfaSetupRequired: await this.mfaSetupRequired(
        user,
        membership?.tenantId ?? null,
        permissions,
      ),
    };
  }

  /** Store policy: privileged roles must have two-factor on. */
  async mfaSetupRequired(
    user: Pick<User, 'mfaEnabled'>,
    tenantId: string | null,
    permissions: Permission[],
  ): Promise<boolean> {
    if (!tenantId || user.mfaEnabled) return false;
    const settings = await this.settingsService.getSettings(tenantId);
    return requiresMfaSetup(user, permissions, settings);
  }

  /**
   * The account for these credentials, or null. Wrong passwords count towards
   * the account's lockout; a locked account is refused (429) before the password
   * is even checked. Unknown accounts take as long as known ones.
   */
  async validateUser(email: string, password: string): Promise<User | null> {
    const user = await this.userRepository.findOne({
      where: { email: email.trim().toLowerCase() },
    });
    assertNotLocked(user);

    const passwordOk = await passwordMatches(user, password);
    if (!user || user.status !== UserStatus.ACTIVE) return null;
    if (!passwordOk) {
      await recordFailedAttempt(this.userRepository, user.id);
      await this.auditAuthFailure(user, 'auth.login_failed', 'password');
      return null;
    }
    return user;
  }

  async login(email: string, password: string): Promise<LoginResponse> {
    const user = await this.validateUser(email, password);

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    // If MFA is enabled, return a temporary token (no session until the code is
    // verified). It only opens /auth/mfa/verify and carries no profile data.
    if (user.mfaEnabled) {
      const tempToken = this.jwtService.sign(
        {
          sub: user.id,
          email: user.email,
          mfaVerified: false,
          typ: 'mfa_pending',
        },
        { expiresIn: '5m' },
      );

      return {
        accessToken: tempToken,
        user: await this.getUserInfo(user),
        requiresMfa: true,
        mfaSetupRequired: false,
      };
    }

    return this.startSession(user, null, 'password');
  }

  async verifyMfaToken(userId: string, token: string): Promise<LoginResponse> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (
      !user ||
      user.status !== UserStatus.ACTIVE ||
      !user.mfaEnabled ||
      !user.mfaSecret
    ) {
      throw new UnauthorizedException('MFA not enabled');
    }
    assertNotLocked(user);

    if (!(await consumeTotp(this.userRepository, user, token))) {
      await recordFailedAttempt(this.userRepository, user.id);
      await this.auditAuthFailure(user, 'auth.mfa_failed', 'code');
      throw new UnauthorizedException('Invalid MFA token');
    }

    return this.startSession(user, null, 'mfa');
  }

  /**
   * Create a session and its access token. The token carries the session id (sid)
   * and the active store (tid). Users the store policy requires to set up two-factor
   * get a restricted token (scope mfa_setup).
   */
  async startSession(
    user: User,
    tenantId: string | null,
    authMethod: 'password' | 'mfa' | 'signup',
  ): Promise<LoginResponse> {
    const info = await this.getUserInfo(user, tenantId);
    const sessionId = this.sessionsService.newId();
    const { accessToken, expiresAt } = this.signAccessToken(
      user,
      sessionId,
      info,
    );
    await this.sessionsService.create(sessionId, {
      userId: user.id,
      tenantId: info.tenantId,
      expiresAt,
      authMethod,
    });
    await this.userRepository.update(user.id, { lastLoginAt: new Date() });
    await clearFailedAttempts(this.userRepository, user.id);
    return {
      accessToken,
      user: info,
      requiresMfa: false,
      mfaSetupRequired: info.mfaSetupRequired,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /** New token for an existing session (after two-factor setup or a store switch). */
  private async reissue(
    user: User,
    sessionId: string,
    tenantId: string | null,
  ): Promise<LoginResponse> {
    const info = await this.getUserInfo(user, tenantId);
    const { accessToken, expiresAt } = this.signAccessToken(
      user,
      sessionId,
      info,
    );
    if (info.tenantId) {
      await this.sessionsService.setTenant(
        sessionId,
        user.id,
        info.tenantId,
        expiresAt,
      );
    }
    return {
      accessToken,
      user: info,
      requiresMfa: false,
      mfaSetupRequired: info.mfaSetupRequired,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private signAccessToken(user: User, sessionId: string, info: UserInfo) {
    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      mfaVerified: true,
      sid: sessionId,
      ...(info.tenantId && { tid: info.tenantId }),
      ...(info.mfaSetupRequired && { scope: 'mfa_setup' as const }),
    };
    const accessToken = this.jwtService.sign(payload);
    const decoded = this.jwtService.decode<JwtPayload | null>(accessToken);
    const expiresAt = decoded?.exp
      ? new Date(decoded.exp * 1000)
      : new Date(Date.now() + 24 * 3600_000);
    return { accessToken, expiresAt };
  }

  /** Stores the user can switch between. */
  async listStores(
    userId: string,
    currentTenantId: string | null,
  ): Promise<StoreOption[]> {
    const memberships = await this.membershipRepository.find({
      where: { userId, status: MembershipStatus.ACTIVE },
      relations: { tenant: true },
      order: { joinedAt: 'ASC' },
    });
    const active = memberships.filter(
      (m) => m.tenant?.status === TenantStatus.ACTIVE,
    );
    const roles = active.length
      ? await this.roleRepository.find({
          where: active.map((m) => ({ tenantId: m.tenantId, key: m.role })),
        })
      : [];
    return active.map((m) => ({
      tenantId: m.tenantId,
      name: m.tenant.name,
      slug: m.tenant.slug,
      role: m.role,
      roleName:
        roles.find((r) => r.tenantId === m.tenantId && r.key === m.role)
          ?.name ?? m.role,
      current: m.tenantId === currentTenantId,
    }));
  }

  /** Stores that added this account and wait for it to accept. */
  async listInvitations(userId: string): Promise<StoreOption[]> {
    const invitations = await this.membershipRepository.find({
      where: { userId, status: MembershipStatus.INVITED },
      relations: { tenant: true },
      order: { joinedAt: 'ASC' },
    });
    const open = invitations.filter(
      (m) => m.tenant?.status === TenantStatus.ACTIVE,
    );
    const roles = open.length
      ? await this.roleRepository.find({
          where: open.map((m) => ({ tenantId: m.tenantId, key: m.role })),
        })
      : [];
    return open.map((m) => ({
      tenantId: m.tenantId,
      name: m.tenant.name,
      slug: m.tenant.slug,
      role: m.role,
      roleName:
        roles.find((r) => r.tenantId === m.tenantId && r.key === m.role)
          ?.name ?? m.role,
      current: false,
    }));
  }

  /** Accept (join the store) or decline (remove) an invitation. */
  async answerInvitation(
    userId: string,
    tenantId: string,
    accept: boolean,
  ): Promise<void> {
    const invitation = await this.membershipRepository.findOne({
      where: { userId, tenantId, status: MembershipStatus.INVITED },
    });
    if (!invitation) throw new NotFoundException('Invitation not found');
    if (accept) {
      await this.membershipRepository.update(invitation.id, {
        status: MembershipStatus.ACTIVE,
        joinedAt: new Date(),
      });
    } else {
      await this.membershipRepository.delete(invitation.id);
    }
    await this.auditService.record({
      tenantId,
      actorId: userId,
      action: accept ? 'user.invitation_accepted' : 'user.invitation_declined',
      entityType: 'user',
      entityId: userId,
    });
  }

  /** Continue the current session in another store the user belongs to. */
  async switchStore(
    user: User & { sessionId?: string | null; tenantId: string | null },
    tenantId: string,
  ): Promise<LoginResponse> {
    const membership = await this.membershipRepository.findOne({
      where: { userId: user.id, tenantId, status: MembershipStatus.ACTIVE },
      relations: { tenant: true },
    });
    if (!membership || membership.tenant?.status !== TenantStatus.ACTIVE) {
      throw new ForbiddenException('You are not a member of this store');
    }
    const response = user.sessionId
      ? await this.reissue(user, user.sessionId, tenantId)
      : await this.startSession(user, tenantId, 'password');
    await this.auditService.record({
      tenantId,
      actorId: user.id,
      action: 'session.store_switched',
      entityType: 'session',
      entityId: user.sessionId ?? null,
      metadata: { fromTenantId: user.tenantId },
    });
    return response;
  }

  /** Sign out the current session. */
  async logout(user: {
    id: string;
    sessionId?: string | null;
    tenantId: string | null;
  }): Promise<void> {
    if (user.sessionId) {
      await this.sessionsService.revokeOwn(
        user.id,
        user.sessionId,
        'logout',
        user.tenantId,
      );
    }
  }

  async enableMfa(userId: string): Promise<{ secret: string; qrCode: string }> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    // Replacing the secret of an active second factor would let a stolen
    // session take it over: it must be turned off (with a code) first
    if (user.mfaEnabled) {
      throw new BadRequestException(
        'Two-factor authentication is already on. Turn it off first to set up a new device.',
      );
    }

    const secret = speakeasy.generateSecret({
      name: `POS (${user.email})`,
      length: 32,
    });

    // Save secret to user
    await this.userRepository.update(userId, {
      mfaSecret: secret.base32,
    });

    // Generate QR code
    const qrCode = await QRCode.toDataURL(secret.otpauth_url || '');

    return {
      secret: secret.base32 || '',
      qrCode,
    };
  }

  async confirmMfa(userId: string, token: string): Promise<boolean> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user || !user.mfaSecret) {
      throw new UnauthorizedException('MFA secret not found');
    }

    if (!(await consumeTotp(this.userRepository, user, token))) {
      throw new UnauthorizedException('Invalid MFA token');
    }

    // Enable MFA for the user
    await this.userRepository.update(userId, { mfaEnabled: true });

    return true;
  }

  /**
   * After two-factor is turned on: audit it and hand the session a full
   * (unrestricted) token.
   */
  async afterMfaEnabled(user: {
    id: string;
    sessionId?: string | null;
    tenantId: string | null;
  }): Promise<LoginResponse | null> {
    if (user.tenantId) {
      await this.auditService.record({
        tenantId: user.tenantId,
        actorId: user.id,
        action: 'user.mfa_enabled',
        entityType: 'user',
        entityId: user.id,
      });
    }
    const fresh = await this.userRepository.findOne({ where: { id: user.id } });
    if (!fresh || !user.sessionId) return null;
    return this.reissue(fresh, user.sessionId, user.tenantId);
  }

  async disableMfa(
    userId: string,
    token: string,
    context?: { tenantId: string | null; permissions: Permission[] },
  ): Promise<boolean> {
    const user = await this.userRepository.findOne({ where: { id: userId } });

    if (!user || !user.mfaEnabled || !user.mfaSecret) {
      throw new UnauthorizedException('MFA not enabled');
    }

    if (
      context &&
      (await this.mfaSetupRequired(
        { mfaEnabled: false },
        context.tenantId,
        context.permissions,
      ))
    ) {
      throw new ForbiddenException(
        'Your store requires two-factor authentication for your role, so it cannot be turned off',
      );
    }

    assertNotLocked(user);
    if (!(await consumeTotp(this.userRepository, user, token))) {
      await recordFailedAttempt(this.userRepository, user.id);
      throw new UnauthorizedException('Invalid MFA token');
    }

    // Disable MFA
    await this.userRepository.update(userId, {
      mfaEnabled: false,
      mfaSecret: null as unknown as string,
    });
    if (context?.tenantId) {
      await this.auditService.record({
        tenantId: context.tenantId,
        actorId: userId,
        action: 'user.mfa_disabled',
        entityType: 'user',
        entityId: userId,
      });
    }

    return true;
  }

  async hashPassword(password: string): Promise<string> {
    const rounds = Number(this.configService?.get('BCRYPT_ROUNDS') ?? 12);
    return bcrypt.hash(password, rounds);
  }

  /**
   * Change one's own password: needs the current one; signs out every other
   * session of the account.
   */
  async changePassword(
    user: { id: string; sessionId?: string | null; tenantId: string | null },
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const account = await this.userRepository.findOne({
      where: { id: user.id },
    });
    if (!account) throw new UnauthorizedException('User not found');
    assertNotLocked(account);
    if (!(await passwordMatches(account, currentPassword))) {
      await recordFailedAttempt(this.userRepository, account.id);
      await this.auditAuthFailure(
        account,
        'auth.password_change_failed',
        'password',
      );
      throw new UnauthorizedException('Your current password is incorrect');
    }
    if (currentPassword === newPassword) {
      throw new BadRequestException(
        'Choose a password different from the current one',
      );
    }
    await this.userRepository.update(account.id, {
      passwordHash: await this.hashPassword(newPassword),
    });
    await this.sessionsService.revokeAllForUser(
      account.id,
      'password_changed',
      {
        exceptSessionId: user.sessionId ?? null,
      },
    );
    if (user.tenantId) {
      await this.auditService.record({
        tenantId: user.tenantId,
        actorId: account.id,
        action: 'user.password_changed',
        entityType: 'user',
        entityId: account.id,
      });
    }
  }

  /**
   * A failed sign-in step, recorded in the audit trail of each store the
   * account belongs to (spec §21: failed high-risk actions are audited).
   */
  private async auditAuthFailure(
    user: Pick<User, 'id'>,
    action: string,
    reason: string,
  ): Promise<void> {
    try {
      const memberships = await this.membershipRepository.find({
        where: { userId: user.id, status: MembershipStatus.ACTIVE },
      });
      for (const m of memberships) {
        await this.auditService.record({
          tenantId: m.tenantId,
          actorId: user.id,
          action,
          entityType: 'user',
          entityId: user.id,
          metadata: { reason },
        });
      }
    } catch (err) {
      // Never let auditing turn a 401 into a 500
      this.logger.warn(`Could not audit ${action}: ${String(err)}`);
    }
  }
}
