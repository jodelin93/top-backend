import {
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { AuthUser } from '../strategies/jwt.strategy';

/**
 * Resolves the tenant ID of the authenticated user.
 * Must be used on routes protected by JwtAuthGuard.
 */
export const CurrentTenant = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): string => {
    const { user } = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();

    if (!user?.tenantId) {
      throw new ForbiddenException('User is not a member of any tenant');
    }

    return user.tenantId;
  },
);
