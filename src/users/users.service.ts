import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
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

export interface Member {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
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
  ) {}

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

    const membershipId = await this.dataSource.transaction(async (manager) => {
      let user = await manager.findOne(User, { where: { email } });
      // An account that already exists (possibly created elsewhere, by anyone)
      // is only invited: it gets no access here until its owner signs in and
      // accepts, and the password typed here is never applied to it.
      const invited = !!user;

      if (!user) {
        if (!dto.password) {
          throw new BadRequestException(
            'A password is required for a new user',
          );
        }
        user = await manager.save(
          manager.create(User, {
            email,
            firstName: dto.firstName,
            lastName: dto.lastName,
            passwordHash: await this.hash(dto.password),
            status: UserStatus.ACTIVE,
          }),
        );
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
