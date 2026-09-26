import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ANY_MEMBER_KEY,
  ANY_PERMISSIONS_KEY,
  APPROVABLE_KEY,
  PERMISSIONS_KEY,
} from '../decorators/permissions.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { Permission } from '../permissions';
import type { AuthUser } from '../strategies/jwt.strategy';
import { ApprovalsService } from '../../approvals/approvals.service';
import { beginApprovalScope } from '../../approvals/approval-scope';
import { requestContext } from '../../common/context/request-context';

export const APPROVAL_HEADER = 'x-approval-token';

/** How a route is protected, as declared by its decorators */
export type RouteAccess =
  | { kind: 'public' }
  | { kind: 'member' }
  | { kind: 'all'; permissions: Permission[] }
  | { kind: 'any'; permissions: Permission[] }
  | { kind: 'undeclared' };

type Target = object;

/**
 * Reads a route's access rule: the handler's own declaration wins over the
 * controller's (e.g. @AnyMember() on one route of a @RequirePermissions() class).
 */
export function routeAccess(
  reflector: Reflector,
  handler: Target,
  controller: Target,
): RouteAccess {
  if (
    reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      handler as never,
      controller as never,
    ])
  ) {
    return { kind: 'public' };
  }
  for (const target of [handler, controller]) {
    const all = reflector.get<Permission[] | undefined>(
      PERMISSIONS_KEY,
      target as never,
    );
    if (all?.length) return { kind: 'all', permissions: all };
    const any = reflector.get<Permission[] | undefined>(
      ANY_PERMISSIONS_KEY,
      target as never,
    );
    if (any?.length) return { kind: 'any', permissions: any };
    if (reflector.get<boolean>(ANY_MEMBER_KEY, target as never)) {
      return { kind: 'member' };
    }
  }
  return { kind: 'undeclared' };
}

/**
 * Deny by default: a route needs @RequirePermissions(), @RequireAnyPermission(),
 * @AnyMember() or @Public(); anything else answers 403.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private approvalsService: ApprovalsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const access = routeAccess(
      this.reflector,
      context.getHandler(),
      context.getClass(),
    );
    if (access.kind === 'public') return true;

    const request = context.switchToHttp().getRequest<{
      user?: AuthUser;
      method?: string;
      originalUrl?: string;
      url?: string;
      headers: Record<string, string | undefined>;
    }>();
    const user = request.user;
    // What approval tokens used in this request are for (see ApprovalsService.verify)
    const scope = beginApprovalScope(
      request.method ?? 'GET',
      request.originalUrl ?? request.url ?? '/',
    );

    if (access.kind === 'undeclared') {
      throw new ForbiddenException({
        message: 'This endpoint does not declare who may use it',
        error: 'Forbidden',
      });
    }
    if (!user) {
      throw new ForbiddenException('You must be signed in');
    }
    if (access.kind === 'member') return true;

    const held = user.permissions ?? [];
    if (access.kind === 'any') {
      if (access.permissions.some((p) => held.includes(p))) return true;
      throw new ForbiddenException({
        message: 'You do not have permission to perform this action',
        error: 'Forbidden',
        missingPermissions: access.permissions,
        approvable: false,
      });
    }

    const missing = access.permissions.filter((p) => !held.includes(p));
    if (missing.length === 0) {
      return true;
    }

    // Manager override for a single missing permission
    const approvable = this.reflector.getAllAndOverride<boolean>(
      APPROVABLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    // Several approvals may travel together (comma-separated): the route
    // accepts the one issued for its missing permission
    const tokens = String(request.headers[APPROVAL_HEADER] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 5);
    if (approvable && missing.length === 1) {
      for (const token of tokens) {
        const approverId = await this.approvalsService.verify(
          token,
          missing[0],
          user,
        );
        if (approverId) {
          requestContext.set({ approverId });
          return true;
        }
      }
    }

    throw new ForbiddenException({
      message: 'You do not have permission to perform this action',
      error: 'Forbidden',
      missingPermissions: missing,
      approvable: !!approvable,
      // The client sends it back to POST /approvals, binding the approval to this action
      ...(approvable && { action: scope.action }),
    });
  }
}
