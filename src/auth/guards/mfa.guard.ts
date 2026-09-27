import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { JwtPayload } from '../auth.service';
import { CookieRequest, extractMfaToken } from '../session-cookie';

interface MfaRequest extends CookieRequest {
  user?: JwtPayload;
}

@Injectable()
export class MfaGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<MfaRequest>();
    // The HttpOnly pos_mfa cookie (web app), else Authorization: Bearer
    const token = extractMfaToken(request);

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
}
