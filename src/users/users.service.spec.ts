import { RolesService } from '../roles/roles.service';
import { AuditService } from '../audit/audit.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User } from '../database/entities/user.entity';
import {
  MembershipRole,
  MembershipStatus,
  TenantMembership,
} from '../database/entities/tenant-membership.entity';
import { AuthUser } from '../auth/strategies/jwt.strategy';
import { UsersService } from './users.service';
import { SYSTEM_ROLES } from '../auth/permissions';
import { resolvePermissions } from '../roles/role-permissions';

const TENANT = 'tenant-1';

const actor = (id: string, role: string) =>
  ({
    id,
    role,
    tenantId: TENANT,
    permissions: resolvePermissions(role, null),
  }) as AuthUser;

// A custom role in the store: can manage staff, but not sell
const STAFF_ADMIN = {
  key: 'staff-admin',
  name: 'Staff admin',
  permissions: ['users.manage'],
};

const membership = (
  userId: string,
  role: MembershipRole,
  status = MembershipStatus.ACTIVE,
) =>
  ({
    id: `m-${userId}`,
    tenantId: TENANT,
    userId,
    role,
    status,
    joinedAt: new Date('2026-01-01'),
    user: { id: userId, email: `${userId}@example.com`, mfaEnabled: false },
  }) as TenantMembership;

describe('UsersService', () => {
  let service: UsersService;
  const membershipRepository = {
    find: jest.fn(),
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    count: jest.fn(),
    save: jest.fn((m: TenantMembership) => Promise.resolve(m)),
  };
  const userRepository = { update: jest.fn() };
  const manager = {
    findOne: jest.fn(),
    create: jest.fn((_entity: unknown, data: object) => data),
    save: jest.fn((data: object) => Promise.resolve({ id: 'new-id', ...data })),
  };
  const dataSource = {
    transaction: jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager),
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        {
          provide: RolesService,
          useValue: {
            // Built-in roles exist; anything else is unknown
            findByKey: jest.fn((_t: string, key: string) =>
              Promise.resolve(
                key in SYSTEM_ROLES
                  ? {
                      key,
                      name: key,
                      permissions: [
                        ...SYSTEM_ROLES[key as keyof typeof SYSTEM_ROLES]
                          .permissions,
                      ],
                    }
                  : key === STAFF_ADMIN.key
                    ? STAFF_ADMIN
                    : null,
              ),
            ),
            findAll: jest.fn(() => Promise.resolve([])),
          },
        },
        { provide: AuditService, useValue: { record: jest.fn() } },
        UsersService,
        {
          provide: getRepositoryToken(TenantMembership),
          useValue: membershipRepository,
        },
        { provide: getRepositoryToken(User), useValue: userRepository },
        // Cheap hashes keep the tests fast
        { provide: ConfigService, useValue: { get: () => '4' } },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(UsersService);
  });

  describe('create', () => {
    it('only lets owners add another owner', async () => {
      await expect(
        service.create(TENANT, actor('admin', MembershipRole.ADMIN), {
          email: 'x@example.com',
          role: MembershipRole.OWNER,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('requires a password for a brand new user', async () => {
      manager.findOne.mockResolvedValue(null);
      await expect(
        service.create(TENANT, actor('owner', MembershipRole.OWNER), {
          email: 'new@example.com',
          role: MembershipRole.CASHIER,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses someone who is already a member', async () => {
      manager.findOne
        .mockResolvedValueOnce({ id: 'u1', email: 'u1@example.com' })
        .mockResolvedValueOnce(membership('u1', MembershipRole.CASHIER));
      await expect(
        service.create(TENANT, actor('owner', MembershipRole.OWNER), {
          email: 'U1@Example.com ',
          role: MembershipRole.CASHIER,
        }),
      ).rejects.toThrow(ConflictException);
      // The email is normalised before lookup
      expect(manager.findOne).toHaveBeenCalledWith(User, {
        where: { email: 'u1@example.com' },
      });
    });

    it('creates the user with a hashed password and adds the membership', async () => {
      manager.findOne.mockResolvedValue(null);
      membershipRepository.findOneOrFail.mockResolvedValue(
        membership('new-id', MembershipRole.CASHIER),
      );
      const member = await service.create(
        TENANT,
        actor('owner', MembershipRole.OWNER),
        {
          email: 'new@example.com',
          password: 'Password123!',
          role: MembershipRole.CASHIER,
        },
      );
      expect(member).toMatchObject({
        id: 'new-id',
        role: MembershipRole.CASHIER,
      });
      const savedUser = manager.save.mock.calls[0][0] as {
        passwordHash: string;
      };
      await expect(
        bcrypt.compare('Password123!', savedUser.passwordHash),
      ).resolves.toBe(true);
      expect(manager.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          tenantId: TENANT,
          role: MembershipRole.CASHIER,
          status: MembershipStatus.ACTIVE,
        }),
      );
    });
  });

  describe('existing accounts', () => {
    it('only invites an account that already exists, ignoring the password typed', async () => {
      manager.findOne
        .mockResolvedValueOnce({ id: 'u9', email: 'alice@example.com' })
        .mockResolvedValueOnce(null);
      membershipRepository.findOneOrFail.mockResolvedValue(
        membership('u9', MembershipRole.CASHIER),
      );
      await service.create(TENANT, actor('owner', MembershipRole.OWNER), {
        email: 'alice@example.com',
        password: 'Password123!',
        role: MembershipRole.CASHIER,
      });
      // No new account, no password change; the membership waits for acceptance
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(manager.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          userId: 'u9',
          status: MembershipStatus.INVITED,
        }),
      );
      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('does not let an admin activate an invitation themselves', async () => {
      membershipRepository.findOne.mockResolvedValue({
        ...membership('u9', MembershipRole.CASHIER),
        status: MembershipStatus.INVITED,
      });
      await expect(
        service.update(TENANT, actor('boss', MembershipRole.OWNER), 'u9', {
          status: MembershipStatus.ACTIVE,
        }),
      ).rejects.toThrow(/not accepted the invitation/);
    });

    it('does not let a store rename an account shared with other stores', async () => {
      membershipRepository.findOne.mockResolvedValue(
        membership('u1', MembershipRole.CASHIER),
      );
      membershipRepository.count.mockResolvedValue(1);
      await expect(
        service.update(TENANT, actor('boss', MembershipRole.OWNER), 'u1', {
          firstName: 'Mallory',
        }),
      ).rejects.toThrow(/also used in another store/);
      expect(userRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('role limits', () => {
    const staffAdmin = {
      ...actor('sa', STAFF_ADMIN.key),
      permissions: ['users.manage'],
    } as AuthUser;

    it('refuses to give a role with permissions the actor lacks, listing them', async () => {
      const error = (await service
        .create(TENANT, staffAdmin, {
          email: 'x@example.com',
          role: MembershipRole.CASHIER,
        })
        .catch((e: unknown) => e)) as ForbiddenException;
      expect(error).toBeInstanceOf(ForbiddenException);
      expect(error.getResponse()).toMatchObject({
        permissionsNotHeld: expect.arrayContaining(['pos.sell']) as string[],
      });
      expect(error.message).toMatch(/pos\.sell/);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('lets the actor give a role within their own permissions', async () => {
      manager.findOne.mockResolvedValue(null);
      membershipRepository.findOneOrFail.mockResolvedValue(
        membership('new-id', MembershipRole.CASHIER),
      );
      await service.create(TENANT, actor('m', MembershipRole.MANAGER), {
        email: 'new@example.com',
        password: 'Password123!',
        role: MembershipRole.CASHIER,
      });
      expect(dataSource.transaction).toHaveBeenCalled();
    });

    it('stops a manager-level actor from promoting someone to admin', async () => {
      membershipRepository.findOne.mockResolvedValue(
        membership('u1', MembershipRole.CASHIER),
      );
      await expect(
        service.update(
          TENANT,
          {
            ...actor('m', MembershipRole.MANAGER),
            permissions: [...SYSTEM_ROLES.manager.permissions, 'users.manage'],
          } as AuthUser,
          'u1',
          { role: MembershipRole.ADMIN },
        ),
      ).rejects.toThrow(/roles\.manage/);
      expect(membershipRepository.save).not.toHaveBeenCalled();
    });

    it('stops a less powerful actor from resetting an admin’s password', async () => {
      membershipRepository.findOne.mockResolvedValue(
        membership('a1', MembershipRole.ADMIN),
      );
      await expect(
        service.resetPassword(TENANT, staffAdmin, 'a1', 'Password123!'),
      ).rejects.toThrow(ForbiddenException);
      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('does not limit owners', async () => {
      membershipRepository.findOne.mockResolvedValue(
        membership('u1', MembershipRole.CASHIER),
      );
      await service.update(TENANT, actor('boss', MembershipRole.OWNER), 'u1', {
        role: MembershipRole.ADMIN,
      });
      expect(membershipRepository.save).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('404s for someone outside the store', async () => {
      membershipRepository.findOne.mockResolvedValue(null);
      await expect(
        service.update(TENANT, actor('owner', MembershipRole.OWNER), 'x', {}),
      ).rejects.toThrow(NotFoundException);
    });

    it.each([
      ['role', { role: MembershipRole.CASHIER }],
      ['status', { status: MembershipStatus.SUSPENDED }],
    ])('does not let you change your own %s', async (_label, dto) => {
      membershipRepository.findOne.mockResolvedValue(
        membership('me', MembershipRole.OWNER),
      );
      await expect(
        service.update(TENANT, actor('me', MembershipRole.OWNER), 'me', dto),
      ).rejects.toThrow('You cannot change your own role or access');
    });

    it('lets you rename yourself', async () => {
      membershipRepository.findOne.mockResolvedValue(
        membership('me', MembershipRole.ADMIN),
      );
      await service.update(TENANT, actor('me', MembershipRole.ADMIN), 'me', {
        firstName: 'New',
      });
      expect(userRepository.update).toHaveBeenCalledWith('me', {
        firstName: 'New',
      });
    });

    it('stops admins from changing an owner', async () => {
      membershipRepository.findOne.mockResolvedValue(
        membership('boss', MembershipRole.OWNER),
      );
      await expect(
        service.update(TENANT, actor('admin', MembershipRole.ADMIN), 'boss', {
          firstName: 'X',
        }),
      ).rejects.toThrow('Only owners can change another owner');
    });

    it('stops admins from promoting someone to owner', async () => {
      membershipRepository.findOne.mockResolvedValue(
        membership('u1', MembershipRole.CASHIER),
      );
      await expect(
        service.update(TENANT, actor('admin', MembershipRole.ADMIN), 'u1', {
          role: MembershipRole.OWNER,
        }),
      ).rejects.toThrow('Only owners can grant the owner role');
    });

    it('lets an owner promote someone to owner', async () => {
      membershipRepository.findOne.mockResolvedValue(
        membership('u1', MembershipRole.CASHIER),
      );
      await service.update(TENANT, actor('boss', MembershipRole.OWNER), 'u1', {
        role: MembershipRole.OWNER,
      });
      expect(membershipRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ role: MembershipRole.OWNER }),
      );
    });

    it.each([
      ['demoting', { role: MembershipRole.ADMIN }],
      ['suspending', { status: MembershipStatus.SUSPENDED }],
    ])('does not allow %s the last owner', async (_label, dto) => {
      membershipRepository.findOne.mockResolvedValue(
        membership('boss', MembershipRole.OWNER),
      );
      membershipRepository.count.mockResolvedValue(0);
      await expect(
        service.update(
          TENANT,
          actor('other', MembershipRole.OWNER),
          'boss',
          dto,
        ),
      ).rejects.toThrow('A store needs at least one active owner');
      expect(membershipRepository.save).not.toHaveBeenCalled();
    });

    it('allows demoting an owner when another active owner remains', async () => {
      membershipRepository.findOne.mockResolvedValue(
        membership('boss', MembershipRole.OWNER),
      );
      membershipRepository.count.mockResolvedValue(1);
      await service.update(
        TENANT,
        actor('other', MembershipRole.OWNER),
        'boss',
        { role: MembershipRole.ADMIN },
      );
      expect(membershipRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ role: MembershipRole.ADMIN }),
      );
    });

    it('records when a member is suspended and clears it on reactivation', async () => {
      const m = membership('u1', MembershipRole.CASHIER);
      membershipRepository.findOne.mockResolvedValue(m);
      const owner = actor('boss', MembershipRole.OWNER);

      await service.update(TENANT, owner, 'u1', {
        status: MembershipStatus.SUSPENDED,
      });
      expect(m.status).toBe(MembershipStatus.SUSPENDED);
      expect(m.leftAt).toBeInstanceOf(Date);

      await service.update(TENANT, owner, 'u1', {
        status: MembershipStatus.ACTIVE,
      });
      expect(m.status).toBe(MembershipStatus.ACTIVE);
      expect(m.leftAt).toBeNull();
    });
  });

  describe('resetPassword', () => {
    it('only lets owners reset an owner’s password', async () => {
      membershipRepository.findOne.mockResolvedValue(
        membership('boss', MembershipRole.OWNER),
      );
      await expect(
        service.resetPassword(
          TENANT,
          actor('admin', MembershipRole.ADMIN),
          'boss',
          'Password123!',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses one’s own password (the current one is needed: /auth/password)', async () => {
      membershipRepository.findOne.mockResolvedValue(
        membership('boss', MembershipRole.OWNER),
      );
      await expect(
        service.resetPassword(
          TENANT,
          actor('boss', MembershipRole.OWNER),
          'boss',
          'Password123!',
        ),
      ).rejects.toThrow(/account settings/);
      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('is blocked for accounts that belong to other stores too', async () => {
      membershipRepository.findOne.mockResolvedValue(
        membership('u1', MembershipRole.CASHIER),
      );
      membershipRepository.count.mockResolvedValue(1);
      await expect(
        service.resetPassword(
          TENANT,
          actor('boss', MembershipRole.OWNER),
          'u1',
          'Password123!',
        ),
      ).rejects.toThrow(/also used in another store/);
      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('stores a bcrypt hash of the new password', async () => {
      membershipRepository.findOne.mockResolvedValue(
        membership('u1', MembershipRole.CASHIER),
      );
      membershipRepository.count.mockResolvedValue(0);
      await service.resetPassword(
        TENANT,
        actor('boss', MembershipRole.OWNER),
        'u1',
        'Password123!',
      );
      const [userId, data] = userRepository.update.mock.calls[0] as [
        string,
        { passwordHash: string },
      ];
      expect(userId).toBe('u1');
      await expect(
        bcrypt.compare('Password123!', data.passwordHash),
      ).resolves.toBe(true);
    });
  });
});
