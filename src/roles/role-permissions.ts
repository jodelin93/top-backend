import { ForbiddenException } from '@nestjs/common';
import { TenantRole } from '../database/entities/tenant-role.entity';
import {
  ALL_PERMISSIONS,
  isPermission,
  OWNER_ROLE,
  Permission,
  SYSTEM_ROLES,
} from '../auth/permissions';

/**
 * Effective permissions of a role. The owner always has everything; a built-in role
 * without a stored row (e.g. a store created before roles existed) uses its defaults.
 */
export function resolvePermissions(
  roleKey: string | null | undefined,
  role: Pick<TenantRole, 'permissions'> | null | undefined,
): Permission[] {
  if (!roleKey) return [];
  if (roleKey === OWNER_ROLE) return [...ALL_PERMISSIONS];
  if (role) return role.permissions.filter(isPermission);
  const builtIn = SYSTEM_ROLES[roleKey as keyof typeof SYSTEM_ROLES];
  return builtIn ? [...builtIn.permissions] : [];
}

/** Who is granting access: their role and effective permissions */
export interface Grantor {
  role?: string | null;
  permissions?: readonly string[] | null;
}

/**
 * The permissions in `granted` the actor doesn't hold themselves (none for owners).
 * Nobody may hand out, through a role, more than they have.
 */
export function permissionsNotHeld(
  actor: Grantor,
  granted: readonly string[],
): string[] {
  if (actor.role === OWNER_ROLE) return [];
  const held = new Set(actor.permissions ?? []);
  return [...new Set(granted)].filter((p) => !held.has(p));
}

/** 403 listing the permissions the actor cannot grant */
export function cannotGrant(
  what: string,
  notHeld: string[],
): ForbiddenException {
  return new ForbiddenException({
    message: `${what}: it includes permissions you do not have yourself (${notHeld.join(', ')})`,
    error: 'Forbidden',
    permissionsNotHeld: notHeld,
  });
}
