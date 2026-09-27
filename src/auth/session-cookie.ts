import type { NextFunction, Request, Response } from 'express';
import { isStrictEnv } from '../config/environment';
import type { LoginResponse } from './auth.service';

/**
 * Browser sessions live in HttpOnly cookies, never in JavaScript-readable storage.
 *
 * - `pos_session`: the session access token. HttpOnly, SameSite=Strict, scoped to
 *   the API prefix, Max-Age = the token's lifetime, Secure on HTTPS.
 * - `pos_mfa`: the password step's 5-minute temporary token (typ mfa_pending),
 *   scoped to the single endpoint that accepts it (POST /auth/mfa/verify).
 *
 * Non-browser clients (tests, scripts, integrations) opt out with the header
 * `X-Auth-Mode: token`: the token is then returned in the JSON body (as before)
 * and no cookie is set; they authenticate with `Authorization: Bearer`.
 */
export const SESSION_COOKIE = 'pos_session';
export const MFA_COOKIE = 'pos_mfa';

/** Header a non-browser client sends to get the token in the response body. */
export const AUTH_MODE_HEADER = 'x-auth-mode';
export const AUTH_MODE_TOKEN = 'token';

/** Anti-CSRF header the web app sends on every request (see CsrfGuard). */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'pos-web';

/** Lifetime of the temporary MFA token (auth.service signs it with 5m). */
export const MFA_PENDING_SECONDS = 5 * 60;

type HeaderBag = Record<string, string | string[] | undefined>;
export interface CookieRequest {
  headers: HeaderBag;
  cookies?: Record<string, string>;
  secure?: boolean;
}

const header = (req: CookieRequest, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** Parse a Cookie header (first value wins, values URI-decoded when possible). */
export function parseCookies(
  cookieHeader: string | undefined,
): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (!name || name in cookies) continue;
    let value = part.slice(index + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

/** Tiny cookie-parser: fills req.cookies (registered in app.setup.ts). */
export function cookieParserMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  const request = req as Request & { cookies?: Record<string, string> };
  if (!request.cookies) {
    request.cookies = parseCookies(req.headers.cookie);
  }
  next();
}

export function readCookie(
  req: CookieRequest,
  name: string,
): string | undefined {
  const cookies = req.cookies ?? parseCookies(header(req, 'cookie'));
  const value = cookies[name];
  return value ? value : undefined;
}

export function bearerToken(req: CookieRequest): string | undefined {
  const [type, token] = header(req, 'authorization')?.split(' ') ?? [];
  return type === 'Bearer' && token ? token : undefined;
}

/** The session access token: the cookie first, else the Authorization bearer. */
export function extractSessionToken(req: CookieRequest): string | null {
  return readCookie(req, SESSION_COOKIE) ?? bearerToken(req) ?? null;
}

/** The client asked for the token in the response body (X-Auth-Mode: token). */
export function wantsTokenInBody(req: CookieRequest): boolean {
  return (
    header(req, AUTH_MODE_HEADER)?.trim().toLowerCase() === AUTH_MODE_TOKEN
  );
}

/**
 * Secure cookies need HTTPS: set on HTTPS requests (req.secure honours
 * X-Forwarded-Proto through the trusted proxies, see TRUST_PROXY) and always in
 * strict environments. AUTH_COOKIE_SECURE=true|false overrides (false only for a
 * plain-http on-premise install; the cookie would otherwise be dropped).
 */
export function cookieIsSecure(req: CookieRequest): boolean {
  const override = process.env.AUTH_COOKIE_SECURE?.trim().toLowerCase();
  if (override === 'true') return true;
  if (override === 'false') return false;
  return !!req.secure || isStrictEnv();
}

/** Cookie path: the API prefix (the cookie is never sent to the web pages). */
export function apiCookiePath(): string {
  const prefix = (process.env.API_PREFIX || 'api/v1').replace(/^\/+|\/+$/g, '');
  return `/${prefix}`;
}

const mfaCookiePath = () => `${apiCookiePath()}/auth/mfa/verify`;

function baseOptions(req: CookieRequest) {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure: cookieIsSecure(req),
  };
}

type CookieResponse = Pick<Response, 'cookie' | 'clearCookie'>;

/**
 * Hand a new session to the client: an HttpOnly cookie for the web app, or the
 * token in the body for a client that asked for it (X-Auth-Mode: token).
 * Browser responses carry no token at all.
 */
export function deliverSession<T extends Partial<LoginResponse>>(
  req: CookieRequest,
  res: CookieResponse,
  response: T,
): T {
  const { accessToken, ...rest } = response;
  // The temporary MFA token (if any) is spent
  if (readCookie(req, MFA_COOKIE)) {
    res.clearCookie(MFA_COOKIE, { ...baseOptions(req), path: mfaCookiePath() });
  }
  if (wantsTokenInBody(req)) return response;
  if (accessToken) {
    const expiresAt = response.expiresAt
      ? new Date(response.expiresAt).getTime()
      : NaN;
    const maxAge = Number.isFinite(expiresAt)
      ? Math.max(0, expiresAt - Date.now())
      : 24 * 3600_000;
    res.cookie(SESSION_COOKIE, accessToken, {
      ...baseOptions(req),
      path: apiCookiePath(),
      maxAge,
    });
  }
  return rest as T;
}

/**
 * Password accepted, second factor pending: the temporary token goes into a
 * 5-minute HttpOnly cookie that only POST /auth/mfa/verify receives. Any older
 * session cookie on this browser is dropped (another user may be signing in).
 */
export function deliverMfaPending<T extends Partial<LoginResponse>>(
  req: CookieRequest,
  res: CookieResponse,
  response: T,
): T {
  if (wantsTokenInBody(req)) return response;
  const { accessToken, ...rest } = response;
  clearSessionCookie(req, res);
  if (accessToken) {
    res.cookie(MFA_COOKIE, accessToken, {
      ...baseOptions(req),
      path: mfaCookiePath(),
      maxAge: MFA_PENDING_SECONDS * 1000,
    });
  }
  return rest as T;
}

/** The temporary MFA token: the cookie first, else the Authorization bearer. */
export function extractMfaToken(req: CookieRequest): string | undefined {
  return readCookie(req, MFA_COOKIE) ?? bearerToken(req);
}

export function clearSessionCookie(req: CookieRequest, res: CookieResponse) {
  res.clearCookie(SESSION_COOKIE, {
    ...baseOptions(req),
    path: apiCookiePath(),
  });
}
