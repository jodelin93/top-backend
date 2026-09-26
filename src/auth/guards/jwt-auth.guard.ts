import {
  Injectable,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';
import { ALLOW_MFA_SETUP_KEY } from '../decorators/mfa-setup.decorator';
import type { AuthUser } from '../strategies/jwt.strategy';

export const MFA_SETUP_REQUIRED = 'MFA_SETUP_REQUIRED';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private reflector: Reflector) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Check if route is marked as public
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const allowed = (await super.canActivate(context)) as boolean;
    if (!allowed) return false;

    // Store policy: privileged users must set up two-factor before doing anything else
    const { user } = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    if (user?.mfaSetupRequired) {
      const allowDuringSetup = this.reflector.getAllAndOverride<boolean>(
        ALLOW_MFA_SETUP_KEY,
        [context.getHandler(), context.getClass()],
      );
      if (!allowDuringSetup) {
        throw new ForbiddenException({
          message:
            'Your store requires two-factor authentication for your role. Set it up in Account security to continue.',
          error: 'Forbidden',
          code: MFA_SETUP_REQUIRED,
        });
      }
    }
    return true;
  }
}
