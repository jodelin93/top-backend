import { SetMetadata } from '@nestjs/common';
import type { Permission } from '../permissions';

export const PERMISSIONS_KEY = 'permissions';
export const ANY_PERMISSIONS_KEY = 'anyPermissions';
export const ANY_MEMBER_KEY = 'anyMember';
export const APPROVABLE_KEY = 'approvable';

/**
 * The signed-in user needs every listed permission (checked by PermissionsGuard).
 */
export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);

/**
 * The signed-in user needs at least one of the listed permissions
 * (e.g. a read shared by two screens run by different roles).
 */
export const RequireAnyPermission = (...permissions: Permission[]) =>
  SetMetadata(ANY_PERMISSIONS_KEY, permissions);

/**
 * Explicit opt-out: every signed-in user may call this route (own profile, store
 * settings the till needs, ...). PermissionsGuard denies routes that declare
 * neither this, @RequirePermissions/@RequireAnyPermission nor @Public.
 */
export const AnyMember = () => SetMetadata(ANY_MEMBER_KEY, true);

/**
 * A user without the permission may still proceed with a manager's approval
 * (X-Approval-Token header from POST /approvals). Only for single-permission routes.
 */
export const AllowApproval = () => SetMetadata(APPROVABLE_KEY, true);
