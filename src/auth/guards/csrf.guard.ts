import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SKIP_CSRF_KEY } from '../decorators/skip-csrf.decorator';
import {
  AUTH_MODE_HEADER,
  AUTH_MODE_TOKEN,
  bearerToken,
  CookieRequest,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  readCookie,
  SESSION_COOKIE,
} from '../session-cookie';

export const CSRF_REQUIRED = 'CSRF_HEADER_REQUIRED';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type CsrfRequest = CookieRequest & { method?: string };

const headerValue = (req: CsrfRequest, name: string) => {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value)?.trim().toLowerCase();
};

/**
 * Does this request need the anti-CSRF header? State-changing requests do, unless
 * they are authenticated with an Authorization bearer token and carry no session
 * cookie: browsers never attach that header on their own, so it can't be forged.
 * Public endpoints (sign-in, sign-up) need it too, against login CSRF.
 */
export function csrfCheckRequired(req: CsrfRequest): boolean {
  if (SAFE_METHODS.has((req.method ?? 'GET').toUpperCase())) return false;
  const usesCookie = !!readCookie(req, SESSION_COOKIE);
  return usesCookie || !bearerToken(req);
}

/**
 * Proof that the request was made by the web app (or another non-browser
 * client), not by a cross-site form or a "simple" cross-site fetch: a custom
 * header, which a browser only sends cross-origin after a CORS preflight that
 * the API refuses to other origins. Together with SameSite=Strict cookies this is
 * the OWASP "custom request header" defence.
 */
export function hasCsrfProof(req: CsrfRequest): boolean {
  return (
    headerValue(req, CSRF_HEADER) === CSRF_HEADER_VALUE ||
    headerValue(req, AUTH_MODE_HEADER) === AUTH_MODE_TOKEN
  );
}

/**
 * Global guard (app.setup.ts): unsafe requests authenticated by the session
 * cookie, or not authenticated yet, must carry `X-Requested-With: pos-web`
 * (or `X-Auth-Mode: token` for API clients); otherwise 403.
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return true;
    const req = context.switchToHttp().getRequest<CsrfRequest>();
    if (!csrfCheckRequired(req) || hasCsrfProof(req)) return true;
    throw new ForbiddenException({
      message: 'Missing anti-CSRF header',
      error: 'Forbidden',
      code: CSRF_REQUIRED,
    });
  }
}
