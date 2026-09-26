import { ForbiddenException } from '@nestjs/common';
import { Repository } from 'typeorm';
import { TenantRole } from '../database/entities/tenant-role.entity';
import { TenantMembership } from '../database/entities/tenant-membership.entity';
import { AuditService } from '../audit/audit.service';
import { SYSTEM_ROLES } from '../auth/permissions';
import { RolesService } from './roles.service';

const TENANT = 't1';

describe('RolesService (grant limits)', () => {
  const roleRepository = {
    exists: jest.fn(() => Promise.resolve(false)),
    findOne: jest.fn(),
    create: jest.fn((data: object) => data),
    save: jest.fn((data: object) => Promise.resolve({ id: 'r1', ...data })),
  };
  const service = new RolesService(
    roleRepository as unknown as Repository<TenantRole>,
    {} as Repository<TenantMembership>,
    { record: jest.fn() } as unknown as AuditService,
  );
  // roles.manage without much else
  const roleManager = {
    role: 'role-admin',
    permissions: ['roles.manage', 'pos.sell'],
  };

  beforeEach(() => jest.clearAllMocks());

  it('refuses to create a role with permissions the actor lacks', async () => {
    const error = (await service
      .create(
        TENANT,
        {
          key: 'super',
          name: 'Super',
          permissions: ['pos.sell', 'users.manage', 'audit.view'],
        },
        roleManager,
      )
      .catch((e: unknown) => e)) as ForbiddenException;
    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.getResponse()).toMatchObject({
      permissionsNotHeld: ['users.manage', 'audit.view'],
    });
    expect(roleRepository.save).not.toHaveBeenCalled();
  });

  it('creates a role within the actor’s permissions', async () => {
    await service.create(
      TENANT,
      { key: 'seller', name: 'Seller', permissions: ['pos.sell'] },
      roleManager,
    );
    expect(roleRepository.save).toHaveBeenCalled();
  });

  it('refuses to add permissions the actor lacks to an existing role', async () => {
    roleRepository.findOne.mockResolvedValue({
      id: 'r2',
      key: 'seller',
      permissions: ['pos.sell'],
    });
    await expect(
      service.update(
        TENANT,
        'r2',
        { permissions: ['pos.sell', 'sales.void'] },
        roleManager,
      ),
    ).rejects.toThrow(/sales\.void/);
  });

  it('refuses to edit a role more powerful than the actor', async () => {
    roleRepository.findOne.mockResolvedValue({
      id: 'r3',
      key: 'admin',
      permissions: [...SYSTEM_ROLES.admin.permissions],
    });
    await expect(
      service.update(TENANT, 'r3', { name: 'Renamed' }, roleManager),
    ).rejects.toThrow(ForbiddenException);
    expect(roleRepository.save).not.toHaveBeenCalled();
  });

  it('lets owners grant anything (but never edit the owner role)', async () => {
    const owner = { role: 'owner', permissions: [] };
    await service.create(
      TENANT,
      { key: 'all', name: 'All', permissions: ['users.manage'] },
      owner,
    );
    expect(roleRepository.save).toHaveBeenCalled();
    roleRepository.findOne.mockResolvedValue({
      id: 'o',
      key: 'owner',
      permissions: [],
    });
    await expect(
      service.update(TENANT, 'o', { name: 'Boss' }, owner),
    ).rejects.toThrow('The owner role always has full access');
  });
});
