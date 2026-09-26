import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from '../auth.service';

interface MfaRequest {
  headers: { authorization?: string };
  user?: JwtPayload;
}

@Injectable()
export class MfaGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<MfaRequest>();
    const token = this.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('Token not found');
    }

    try {
      const payload = this.jwtService.verify<JwtPayload>(token);

      // Only the password step's temporary token opens the MFA verification
      // endpoint (not an access token, not a manager's approval token)
      if (payload.typ !== 'mfa_pending' || payload.mfaVerified) {
        throw new UnauthorizedException('Invalid token');
      }

      request.user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid token');
    }
  }

  private extractTokenFromHeader(request: MfaRequest): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
