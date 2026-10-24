import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, In, Not, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserStatus } from '../database/entities/user.entity';
import {
  MembershipStatus,
  TenantMembership,
} from '../database/entities/tenant-membership.entity';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { RolesService } from '../roles/roles.service';
import {
  cannotGrant,
  permissionsNotHeld,
  resolvePermissions,
} from '../roles/role-permissions';
import { OWNER_ROLE } from '../auth/permissions';
import {
  branchScope,
  isBranchSubset,
  membershipBranchIds,
} from '../auth/branch-scope';
import { Branch } from '../database/entities/branch.entity';
import { AuditService } from '../audit/audit.service';
import { SessionsService } from '../sessions/sessions.service';
import { OutboxService } from '../platform/outbox/outbox.service';
import { CreateMemberDto, UpdateMemberDto } from './users.dto';
import {
  EMAIL_CHANNEL,
  type EmailChannel,
} from '../notifications/email/email-channel';
import {
  hashToken,
  MAX_LINKS_PER_HOUR,
  SETUP_LINK_HOURS,
} from '../auth/password-reset.service';
import { accountSetupEmail } from '../auth/account-setup-email';
import { maskEmailsIn } from '../documents/print-job-rules';

export interface Member {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  // Added by the store and has not opened the "choose your password" link yet
  passwordSetupPending: boolean;
  // Opened a link from their mailbox (setup or password reset)
  emailVerified: boolean;
  mfaEnabled: boolean;
  lastLoginAt: Date | null;
  role: string;
  roleName: string;
  status: MembershipStatus;
  joinedAt: Date;
  // Branches the member works in: null = every branch (owners always)
  branchIds: string[] | null;
  // Branches of the employee record linked to this user (to prefill branchIds)
  employeeBranchIds: string[] | null;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(TenantMembership)
    private membershipRepository: Repository<TenantMembership>,
    @InjectRepository(User)
    private userRepository: Repository<User>,
    private configService: ConfigService,
    private dataSource: DataSource,
    private rolesService: RolesService,
    private auditService: AuditService,
    // Signs members out when their access changes (optional so unit tests can omit it)
    @Optional() private sessionsService?: SessionsService,
    // Domain events (user.role_changed); optional for unit tests
    @Optional() private outbox?: OutboxService,
    // The "choose your password" e-mail; optional for unit tests
    @Optional() @Inject(EMAIL_CHANNEL) private email?: EmailChannel,
  ) {}

  private appUrl(): string | null {
    const url =
      this.configService.get<string>('APP_URL') ||
      this.configService.get<string>('FRONTEND_URL') ||
      process.env.APP_URL ||
      process.env.FRONTEND_URL;
    return url ? url.replace(/\/+$/, '') : null;
  }

  /** Can new users get their "choose your password" link by e-mail? */
  private canEmailLinks(): boolean {
    return !!this.email?.enabled && !!this.appUrl();
  }

  /**
   * E-mails a single-use link to choose a password (and confirm the address).
   * It replaces the person's unused links; at most MAX_LINKS_PER_HOUR an hour.
   */
  private async sendSetupLink(
    tenantId: string,
    userId: string,
    language: unknown,
  ): Promise<void> {
    const appUrl = this.appUrl();
    if (!this.email?.enabled || !appUrl) {
      throw new BadRequestException(
        'E-mail sending is not set up, so no link can be sent',
      );
    }
    const [{ recent }] = await this.dataSource.query<{ recent: number }[]>(
      `SELECT count(*)::int AS recent FROM password_reset_tokens
        WHERE "userId" = $1 AND "createdAt" > now() - interval '1 hour'`,
      [userId],
    );
    if (recent >= MAX_LINKS_PER_HOUR) {
      throw new HttpException(
        'Several links were sent in the last hour. Try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const [user] = await this.dataSource.query<
      { email: string; firstName: string | null }[]
    >(`SELECT email, "firstName" FROM users WHERE id = $1`, [userId]);
    const [store] = await this.dataSource.query<{ name: string }[]>(
      `SELECT name FROM tenants WHERE id = $1`,
      [tenantId],
    );
    const token = randomBytes(32).toString('base64url');
    await this.dataSource.query(
      `DELETE FROM password_reset_tokens WHERE "userId" = $1 AND "usedAt" IS NULL`,
      [userId],
    );
    await this.dataSource.query(
      `INSERT INTO password_reset_tokens ("userId", "tokenHash", "expiresAt", purpose)
       VALUES ($1, $2, now() + make_interval(hours => $3), 'setup')`,
      [userId, hashToken(token), SETUP_LINK_HOURS],
    );
    const message = accountSetupEmail({
      link: `${appUrl}/auth/reset-password?token=${token}&setup=1`,
      firstName: user?.firstName,
      storeName: store?.name ?? null,
      language,
      hours: SETUP_LINK_HOURS,
    });
    try {
      await this.email.send({ to: user.email, ...message });
    } catch (error) {
      this.logger.warn(
        `Could not e-mail an account setup link: ${maskEmailsIn(error instanceof Error ? error.message : String(error))}`,
      );
      throw new HttpException(
        'The e-mail could not be sent. Check the address, then send the link again.',
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /** POST /users/:userId/setup-link: the "choose your password" link again */
  async resendSetupLink(
    tenantId: string,
    actor: AuthUser,
    userId: string,
    language: unknown,
  ): Promise<void> {
    const membership = await this.getMembership(tenantId, userId);
    await this.assertCanManageMember(tenantId, actor, membership.role);
    this.assertCanManageBranches(actor, membership);
    if (!membership.user.passwordSetupPending) {
      throw new ConflictException(
        'This person has already chosen their password',
      );
    }
    await this.sendSetupLink(tenantId, userId, language);
    await this.auditService.record({
      tenantId,
      action: 'user.setup_link_sent',
      entityType: 'user',
      entityId: userId,
    });
  }

  async findAll(tenantId: string): Promise<Member[]> {
    const memberships = await this.membershipRepository.find({
      where: { tenantId },
      relations: { user: true },
      order: { joinedAt: 'ASC' },
    });
    const roles = await this.rolesService.findAll(tenantId);
    const employeeBranches = await this.employeeBranchesOf(
      tenantId,
      memberships.map((m) => m.userId),
    );
    return memberships.map((m) =>
      this.toMember(m, roles, employeeBranches.get(m.userId) ?? null),
    );
  }

  /**
   * Add someone to the store: creates the user account if the email is new
   */
  async create(
    tenantId: string,
    actor: AuthUser,
    dto: CreateMemberDto,
  ): Promise<Member> {
    await this.assertCanAssignRole(tenantId, actor, dto.role);
    // Not given: every branch, or the actor's own branches if they are limited
    const branchIds = await this.assertCanGrantBranches(
      tenantId,
      actor,
      dto.role,
      dto.branchIds === undefined ? branchScope(actor) : dto.branchIds,
    );
    const email = dto.email.trim().toLowerCase();
    const byLink = this.canEmailLinks();
    // The new account (not an existing one invited here)
    let created: string | null = null;

    const membershipId = await this.dataSource.transaction(async (manager) => {
      let user = await manager.findOne(User, { where: { email } });
      // An account that already exists (possibly created elsewhere, by anyone)
      // is only invited: it gets no access here until its owner signs in and
      // accepts, and the password typed here is never applied to it.
      const invited = !!user;

      if (!user) {
        // The person chooses their own password from a link e-mailed to them
        // (confirming the address); until then the account can't be used.
        // Without e-mail sending (local work), the password typed here is used.
        if (!byLink && !dto.password) {
          throw new BadRequestException(
            'A password is required for a new user',
          );
        }
        user = await manager.save(
          manager.create(User, {
            email,
            firstName: dto.firstName,
            lastName: dto.lastName,
            passwordHash: await this.hash(
              byLink ? randomBytes(32).toString('base64url') : dto.password!,
            ),
            passwordSetupPending: byLink,
            status: UserStatus.ACTIVE,
          }),
        );
        created = user.id;
      }

      const existing = await manager.findOne(TenantMembership, {
        where: { tenantId, userId: user.id },
      });
      if (existing) {
        throw new ConflictException(
          'This person is already a member of the store',
        );
      }

      const membership = await manager.save(
        manager.create(TenantMembership, {
          tenantId,
          userId: user.id,
          role: dto.role,
          status: invited ? MembershipStatus.INVITED : MembershipStatus.ACTIVE,
          branchIds,
        }),
      );
      await this.auditService.record(
        {
          tenantId,
          action: invited ? 'user.invited' : 'user.added',
          entityType: 'user',
          entityId: user.id,
          changes: { after: { email, role: dto.role, branchIds } },
        },
        manager,
      );
      return membership.id;
    });
    // The link goes out once the account exists; a failure is reported (the
    // member is kept: "send the link again" from the list)
    if (created && byLink)
      await this.sendSetupLink(tenantId, created, dto.language);

    return this.toMember(
      await this.getMembershipById(tenantId, membershipId),
      await this.rolesService.findAll(tenantId),
    );
  }

  async update(
    tenantId: string,
    actor: AuthUser,
    userId: string,
    dto: UpdateMemberDto,
  ): Promise<Member> {
    const membership = await this.getMembership(tenantId, userId);

    const changesAccess =
      dto.role !== undefined ||
      dto.status !== undefined ||
      dto.branchIds !== undefined;
    if (changesAccess && userId === actor.id) {
      throw new ForbiddenException('You cannot change your own role or access');
    }
    if (membership.role === OWNER_ROLE && actor.role !== OWNER_ROLE) {
      throw new ForbiddenException('Only owners can change another owner');
    }
    if (userId !== actor.id) {
      await this.assertCanManageMember(tenantId, actor, membership.role);
      this.assertCanManageBranches(actor, membership);
    }
    if (
      dto.status !== undefined &&
      membership.status === MembershipStatus.INVITED
    ) {
      throw new ForbiddenException(
        'This person has not accepted the invitation yet',
      );
    }
    // Names live on the account, shared by every store it belongs to: only
    // the person, or a store that is the account's only one, may rename it
    if (
      (dto.firstName !== undefined || dto.lastName !== undefined) &&
      userId !== actor.id &&
      (await this.membershipRepository.count({
        where: { userId, tenantId: Not(tenantId) },
      })) > 0
    ) {
      throw new ForbiddenException(
        'This account is also used in another store. The user must change their name themselves.',
      );
    }
    if (dto.role) {
      await this.assertCanAssignRole(tenantId, actor, dto.role);
    }
    const newRole = dto.role ?? membership.role;
    const branchIds =
      dto.branchIds !== undefined || newRole === OWNER_ROLE
        ? await this.assertCanGrantBranches(
            tenantId,
            actor,
            newRole,
            dto.branchIds === undefined ? membership.branchIds : dto.branchIds,
          )
        : membership.branchIds;

    const losesOwner =
      membership.role === OWNER_ROLE &&
      ((dto.role && dto.role !== OWNER_ROLE) ||
        dto.status === MembershipStatus.SUSPENDED);
    if (losesOwner) {
      const otherOwners = await this.membershipRepository.count({
        where: {
          tenantId,
          role: OWNER_ROLE,
          status: MembershipStatus.ACTIVE,
          userId: Not(userId),
        },
      });
      if (otherOwners === 0) {
        throw new BadRequestException(
          'A store needs at least one active owner',
        );
      }
    }

    const before = {
      role: membership.role,
      status: membership.status,
      firstName: membership.user.firstName,
      lastName: membership.user.lastName,
      branchIds: membership.branchIds ?? null,
    };
    if (dto.role) membership.role = dto.role;
    membership.branchIds = branchIds;
    if (dto.status) {
      membership.status = dto.status;
      membership.leftAt = (
        dto.status === MembershipStatus.SUSPENDED ? new Date() : null
      ) as Date;
    }
    const outbox = this.outbox;
    if (outbox && dto.role && dto.role !== before.role) {
      // The role change and its event commit together
      const newRole = dto.role;
      await this.dataSource.transaction(async (manager) => {
        await manager.getRepository(TenantMembership).save(membership);
        await outbox.record(manager, {
          tenantId,
          type: 'user.role_changed',
          aggregateId: userId,
          payload: { userId, previousRole: before.role, newRole },
        });
      });
    } else {
      await this.membershipRepository.save(membership);
    }

    if (dto.firstName !== undefined || dto.lastName !== undefined) {
      await this.userRepository.update(userId, {
        ...(dto.firstName !== undefined && { firstName: dto.firstName }),
        ...(dto.lastName !== undefined && { lastName: dto.lastName }),
      });
    }

    await this.auditService.record({
      tenantId,
      action:
        dto.role && dto.role !== before.role
          ? 'user.role_changed'
          : dto.status && dto.status !== before.status
            ? `user.${dto.status}`
            : dto.branchIds !== undefined &&
                !sameBranches(before.branchIds, branchIds)
              ? 'user.branches_changed'
              : 'user.updated',
      entityType: 'user',
      entityId: userId,
      changes: { before, after: dto },
    });

    // Access changed: end the member's sessions in this store so it applies at once
    const roleChanged = !!dto.role && dto.role !== before.role;
    const suspended =
      dto.status === MembershipStatus.SUSPENDED &&
      before.status !== MembershipStatus.SUSPENDED;
    if (roleChanged || suspended) {
      await this.sessionsService?.revokeForMemberChange(
        tenantId,
        userId,
        suspended ? 'member_suspended' : 'role_changed',
      );
    }

    return this.toMember(
      await this.getMembership(tenantId, userId),
      await this.rolesService.findAll(tenantId),
    );
  }

  /**
   * Set a new password for a member whose account belongs only to this store
   */
  async resetPassword(
    tenantId: string,
    actor: AuthUser,
    userId: string,
    password: string,
  ) {
    // One's own password is changed with the current one (POST /auth/password):
    // otherwise a borrowed session could take the account over for good
    if (userId === actor.id) {
      throw new ForbiddenException(
        'Change your own password from your account settings',
      );
    }
    const membership = await this.getMembership(tenantId, userId);
    if (membership.role === OWNER_ROLE && actor.role !== OWNER_ROLE) {
      throw new ForbiddenException("Only owners can reset an owner's password");
    }
    // Their e-mail is confirmed by choosing the password from the link
    if (membership.user.passwordSetupPending) {
      throw new ConflictException(
        'This person has not chosen a password yet: send them the link again',
      );
    }
    // Taking over a more powerful account would be a way around the role limits
    await this.assertCanManageMember(tenantId, actor, membership.role);
    this.assertCanManageBranches(actor, membership);
    const otherStores = await this.membershipRepository.count({
      where: { userId, tenantId: Not(tenantId) },
    });
    if (otherStores > 0) {
      throw new ForbiddenException(
        'This account is also used in another store. The user must change the password themselves.',
      );
    }
    await this.userRepository.update(userId, {
      passwordHash: await this.hash(password),
    });
    await this.auditService.record({
      tenantId,
      action: 'user.password_reset',
      entityType: 'user',
      entityId: userId,
    });
    // A new password signs the account out everywhere
    await this.sessionsService?.revokeForMemberChange(
      tenantId,
      userId,
      'password_reset',
      true,
    );
  }

  /**
   * The owner turns off someone's two-factor authentication (lost phone, codes
   * refused): the lock is lifted too and the account is signed out everywhere.
   * At their next sign-in, a role that needs it sets two-factor up again.
   */
  async resetMfa(tenantId: string, actor: AuthUser, userId: string) {
    if (actor.role !== OWNER_ROLE) {
      throw new ForbiddenException(
        'Only an owner can reset two-factor authentication',
      );
    }
    if (userId === actor.id) {
      throw new ForbiddenException(
        'Turn off your own two-factor authentication from your account settings',
      );
    }
    const membership = await this.getMembership(tenantId, userId);
    // Two-factor protects the whole account: not from one of its stores only
    const otherStores = await this.membershipRepository.count({
      where: { userId, tenantId: Not(tenantId) },
    });
    if (otherStores > 0) {
      throw new ForbiddenException(
        'This account is also used in another store. The user must turn off two-factor themselves.',
      );
    }
    const wasOn = !!membership.user.mfaEnabled;
    await this.userRepository.update(userId, {
      mfaEnabled: false,
      mfaSecret: null as unknown as string,
      mfaLastUsedStep: null,
      failedLoginCount: 0,
      lockedUntil: null,
    });
    await this.auditService.record({
      tenantId,
      action: 'user.mfa_reset',
      entityType: 'user',
      entityId: userId,
      changes: { before: { mfaEnabled: wasOn }, after: { mfaEnabled: false } },
    });
    await this.sessionsService?.revokeForMemberChange(
      tenantId,
      userId,
      'mfa_reset',
      true,
    );
  }

  /**
   * The role must exist in this store; only owners can grant the owner role, and
   * nobody else can grant a role with permissions they don't have themselves
   */
  private async assertCanAssignRole(
    tenantId: string,
    actor: AuthUser,
    role: string,
  ) {
    const found = await this.rolesService.findByKey(tenantId, role);
    if (!found) {
      throw new BadRequestException(`Unknown role: ${role}`);
    }
    if (role === OWNER_ROLE && actor.role !== OWNER_ROLE) {
      throw new ForbiddenException('Only owners can grant the owner role');
    }
    const notHeld = permissionsNotHeld(actor, resolvePermissions(role, found));
    if (notHeld.length) {
      throw cannotGrant(`You cannot give the role "${found.name}"`, notHeld);
    }
  }

  /**
   * Branches given to a member (spec §9), validated and normalised: null = every
   * branch. Owners always have every branch. No escalation: only a user with
   * every branch can give every branch; others only branches they have.
   */
  private async assertCanGrantBranches(
    tenantId: string,
    actor: AuthUser,
    role: string,
    requested: readonly string[] | null | undefined,
  ): Promise<string[] | null> {
    if (role === OWNER_ROLE) {
      if (requested) {
        throw new BadRequestException(
          'Owners always have access to every branch',
        );
      }
      return null;
    }
    const branchIds = requested ? [...new Set(requested)] : null;
    if (!isBranchSubset(branchIds, branchScope(actor))) {
      throw new ForbiddenException(
        branchIds === null
          ? 'Only users with access to every branch can give access to every branch'
          : 'You can only give access to branches you have access to',
      );
    }
    if (branchIds?.length) {
      const found = await this.dataSource.getRepository(Branch).count({
        where: { tenantId, id: In(branchIds) },
      });
      if (found !== branchIds.length) {
        throw new BadRequestException('Unknown branch');
      }
    }
    return branchIds;
  }

  /**
   * 403 unless the actor may manage this member's account (their sessions…):
   * not themselves through admin routes, owners only by owners, never someone
   * with more permissions or branches than the actor.
   */
  async assertCanManageAccount(
    tenantId: string,
    actor: AuthUser,
    userId: string,
  ): Promise<void> {
    const membership = await this.getMembership(tenantId, userId);
    if (userId === actor.id) return;
    if (membership.role === OWNER_ROLE && actor.role !== OWNER_ROLE) {
      throw new ForbiddenException('Only owners can manage an owner');
    }
    await this.assertCanManageMember(tenantId, actor, membership.role);
    this.assertCanManageBranches(actor, membership);
  }

  // A branch-limited user may not manage someone with access beyond their own
  private assertCanManageBranches(
    actor: AuthUser,
    member: Pick<TenantMembership, 'role' | 'branchIds'>,
  ) {
    if (!isBranchSubset(membershipBranchIds(member), branchScope(actor))) {
      throw new ForbiddenException(
        'You cannot change this member, who has access to branches you do not',
      );
    }
  }

  /** Branches of the employees linked to these users (primary first) */
  private async employeeBranchesOf(tenantId: string, userIds: string[]) {
    const result = new Map<string, string[]>();
    if (!userIds.length) return result;
    const rows = await this.dataSource.query<
      { userId: string; branchIds: string[] }[]
    >(
      `SELECT e."userId", array_agg(eb."branchId" ORDER BY eb."isPrimary" DESC, eb.created_at) AS "branchIds"
         FROM employees e
         JOIN employee_branches eb ON eb."employeeId" = e.id AND eb."tenantId" = e."tenantId"
        WHERE e."tenantId" = $1 AND e."userId" = ANY($2::uuid[])
        GROUP BY e."userId"`,
      [tenantId, userIds],
    );
    for (const row of rows) result.set(row.userId, row.branchIds);
    return result;
  }

  // Only someone with at least the member's permissions may change their account
  private async assertCanManageMember(
    tenantId: string,
    actor: AuthUser,
    memberRole: string,
  ) {
    if (actor.role === OWNER_ROLE) return;
    const role = await this.rolesService.findByKey(tenantId, memberRole);
    const notHeld = permissionsNotHeld(
      actor,
      resolvePermissions(memberRole, role),
    );
    if (notHeld.length) {
      throw cannotGrant(
        'You cannot change this member, whose role has more access than yours',
        notHeld,
      );
    }
  }

  private async getMembership(tenantId: string, userId: string) {
    const membership = await this.membershipRepository.findOne({
      where: { tenantId, userId },
      relations: { user: true },
    });
    if (!membership) {
      throw new NotFoundException('Member not found');
    }
    return membership;
  }

  private async getMembershipById(tenantId: string, id: string) {
    return this.membershipRepository.findOneOrFail({
      where: { tenantId, id },
      relations: { user: true },
    });
  }

  private hash(password: string) {
    return bcrypt.hash(
      password,
      Number(this.configService.get('BCRYPT_ROUNDS') ?? 12),
    );
  }

  private toMember(
    m: TenantMembership,
    roles: { key: string; name: string }[],
    employeeBranchIds: string[] | null = null,
  ): Member {
    return {
      branchIds: membershipBranchIds(m),
      employeeBranchIds,
      roleName: roles.find((r) => r.key === m.role)?.name ?? m.role,
      id: m.user.id,
      email: m.user.email,
      firstName: m.user.firstName ?? null,
      lastName: m.user.lastName ?? null,
      passwordSetupPending: !!m.user.passwordSetupPending,
      emailVerified: !!m.user.emailVerifiedAt,
      mfaEnabled: m.user.mfaEnabled,
      lastLoginAt: m.user.lastLoginAt ?? null,
      role: m.role,
      status: m.status,
      joinedAt: m.joinedAt,
    };
  }
}

const sameBranches = (a: string[] | null, b: string[] | null) =>
  a === b ||
  (!!a && !!b && a.length === b.length && a.every((id) => b.includes(id)));
