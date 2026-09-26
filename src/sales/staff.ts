import { EntityManager } from 'typeorm';
import {
  MembershipStatus,
  TenantMembership,
} from '../database/entities/tenant-membership.entity';
import { TenantRole } from '../database/entities/tenant-role.entity';
import { UserStatus } from '../database/entities/user.entity';
import type { Permission } from '../auth/permissions';
import { resolvePermissions } from '../roles/role-permissions';

export interface StaffMember {
  id: string;
  name: string;
}

// Who can be credited with a sale: people who sell or write estimates
const SELLING_PERMISSIONS: Permission[] = ['pos.sell', 'estimates.manage'];

/**
 * Active members of the store (active account, active membership) whose role lets
 * them sell. With `userId`, only that person (empty when they don't qualify).
 */
export async function sellingStaff(
  manager: EntityManager,
  tenantId: string,
  userId?: string,
): Promise<StaffMember[]> {
  const memberships = await manager.find(TenantMembership, {
    where: {
      tenantId,
      status: MembershipStatus.ACTIVE,
      ...(userId ? { userId } : {}),
    },
    relations: { user: true },
  });
  const active = memberships.filter(
    (m) => m.user && m.user.status === UserStatus.ACTIVE,
  );
  if (active.length === 0) return [];

  const roles = await manager.find(TenantRole, { where: { tenantId } });
  const byKey = new Map(roles.map((r) => [r.key, r]));
  return active
    .filter((m) => {
      const permissions = resolvePermissions(m.role, byKey.get(m.role));
      return SELLING_PERMISSIONS.some((p) => permissions.includes(p));
    })
    .map((m) => ({
      id: m.userId,
      name:
        [m.user.firstName, m.user.lastName].filter(Boolean).join(' ') ||
        m.user.email,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
