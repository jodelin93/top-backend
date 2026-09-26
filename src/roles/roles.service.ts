import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { TenantRole } from '../database/entities/tenant-role.entity';
import { TenantMembership } from '../database/entities/tenant-membership.entity';
import {
  isPermission,
  OWNER_ROLE,
  PERMISSIONS,
  SYSTEM_ROLES,
} from '../auth/permissions';
import { AuditService } from '../audit/audit.service';
import { CreateRoleDto, UpdateRoleDto } from './roles.dto';
import {
  cannotGrant,
  Grantor,
  permissionsNotHeld,
  resolvePermissions,
} from './role-permissions';

@Injectable()
export class RolesService {
  constructor(
    @InjectRepository(TenantRole)
    private roleRepository: Repository<TenantRole>,
    @InjectRepository(TenantMembership)
    private membershipRepository: Repository<TenantMembership>,
    private auditService: AuditService,
  ) {}

  /**
   * Make sure the store has the built-in roles (new stores, or stores created
   * before roles existed). Existing rows are left as they are.
   */
  async ensureSystemRoles(tenantId: string, manager?: EntityManager) {
    const repo = manager
      ? manager.getRepository(TenantRole)
      : this.roleRepository;
    const existing = await repo.find({ where: { tenantId } });
    for (const [key, role] of Object.entries(SYSTEM_ROLES)) {
      if (!existing.some((r) => r.key === key)) {
        await repo.save(
          repo.create({
            tenantId,
            key,
            name: role.name,
            description: role.description,
            permissions: role.permissions,
            isSystem: true,
          }),
        );
      }
    }
  }

  permissionCatalog() {
    return Object.entries(PERMISSIONS).map(([key, value]) => ({
      key,
      ...value,
    }));
  }

  async findAll(tenantId: string) {
    await this.ensureSystemRoles(tenantId);
    const [roles, counts] = await Promise.all([
      this.roleRepository.find({
        where: { tenantId },
        order: { isSystem: 'DESC', name: 'ASC' },
      }),
      this.membershipRepository
        .createQueryBuilder('m')
        .select('m.role', 'role')
        .addSelect('COUNT(*)', 'count')
        .where('m.tenantId = :tenantId', { tenantId })
        .groupBy('m.role')
        .getRawMany<{ role: string; count: string }>(),
    ]);
    return roles.map((role) => ({
      ...role,
      memberCount: Number(counts.find((c) => c.role === role.key)?.count ?? 0),
    }));
  }

  async findByKey(tenantId: string, key: string) {
    await this.ensureSystemRoles(tenantId);
    return this.roleRepository.findOne({ where: { tenantId, key } });
  }

  async create(tenantId: string, dto: CreateRoleDto, actor: Grantor) {
    this.assertPermissions(dto.permissions);
    const notHeld = permissionsNotHeld(actor, dto.permissions);
    if (notHeld.length) {
      throw cannotGrant('You cannot create this role', notHeld);
    }
    if (
      await this.roleRepository.exists({ where: { tenantId, key: dto.key } })
    ) {
      throw new ConflictException(`A role with key ${dto.key} already exists`);
    }
    const role = await this.roleRepository.save(
      this.roleRepository.create({ ...dto, tenantId, isSystem: false }),
    );
    await this.auditService.record({
      tenantId,
      action: 'role.created',
      entityType: 'role',
      entityId: role.key,
      changes: { after: role },
    });
    return role;
  }

  async update(
    tenantId: string,
    id: string,
    dto: UpdateRoleDto,
    actor: Grantor,
  ) {
    const role = await this.findOne(tenantId, id);
    if (role.key === OWNER_ROLE) {
      throw new ForbiddenException(
        'The owner role always has full access and cannot be changed',
      );
    }
    if (dto.permissions) this.assertPermissions(dto.permissions);
    // Neither a role more powerful than you (e.g. admin for a manager with
    // roles.manage), nor adding permissions you don't have
    const notHeld = permissionsNotHeld(actor, [
      ...resolvePermissions(role.key, role),
      ...(dto.permissions ?? []),
    ]);
    if (notHeld.length) {
      throw cannotGrant('You cannot change this role', notHeld);
    }
    const before = { ...role };
    Object.assign(role, dto);
    const saved = await this.roleRepository.save(role);
    await this.auditService.record({
      tenantId,
      action: 'role.updated',
      entityType: 'role',
      entityId: role.key,
      changes: { before, after: saved },
    });
    return saved;
  }

  async remove(tenantId: string, id: string, actor?: Grantor) {
    const role = await this.findOne(tenantId, id);
    if (role.isSystem) {
      throw new ForbiddenException('Built-in roles cannot be deleted');
    }
    // Same delegation limit as editing: not a role more powerful than you
    const notHeld = actor
      ? permissionsNotHeld(actor, resolvePermissions(role.key, role))
      : [];
    if (notHeld.length) {
      throw cannotGrant('You cannot delete this role', notHeld);
    }
    const inUse = await this.membershipRepository.count({
      where: { tenantId, role: role.key },
    });
    if (inUse > 0) {
      throw new ConflictException(
        `${inUse} member(s) still have this role. Change their role first.`,
      );
    }
    await this.roleRepository.remove(role);
    await this.auditService.record({
      tenantId,
      action: 'role.deleted',
      entityType: 'role',
      entityId: role.key,
      changes: { before: role },
    });
  }

  private async findOne(tenantId: string, id: string) {
    const role = await this.roleRepository.findOne({ where: { tenantId, id } });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  private assertPermissions(permissions: string[]) {
    const unknown = permissions.filter((p) => !isPermission(p));
    if (unknown.length) {
      throw new BadRequestException(
        `Unknown permissions: ${unknown.join(', ')}`,
      );
    }
  }
}
