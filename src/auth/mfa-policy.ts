import type { Permission } from './permissions';

/**
 * Permissions that make an account "privileged" for the store's
 * requireMfaForAdmins policy.
 */
export const PRIVILEGED_PERMISSIONS: Permission[] = [
  'users.manage',
  'roles.manage',
  'settings.manage',
  'audit.view',
];

export function requiresMfaSetup(
  user: { mfaEnabled: boolean },
  permissions: readonly string[],
  settings: { requireMfaForAdmins?: boolean },
): boolean {
  return (
    !!settings.requireMfaForAdmins &&
    !user.mfaEnabled &&
    permissions.some((p) => PRIVILEGED_PERMISSIONS.includes(p as Permission))
  );
}
