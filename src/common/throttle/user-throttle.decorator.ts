import { Throttle } from '@nestjs/throttler';
import { heavyThrottle } from '../../config/throttle.config';
import { extractSessionToken } from '../../auth/session-cookie';

type TrackedRequest = {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string>;
  // Set by TenantThrottlerGuard: non-null only when the bearer token verified
  throttleIdentity?: string | null;
};

/**
 * Rate-limit key for per-user limits. The throttler guard runs before the JWT
 * guard (req.user is not set yet), but it has already verified the bearer token
 * (req.throttleIdentity is non-null only then), so reading the `sub` claim here
 * is safe. Unauthenticated / invalid tokens fall back to the client IP.
 */
export function userThrottleTracker(req: TrackedRequest): string {
  const fallback = `ip:${req.ip ?? 'unknown'}`;
  if (!req.throttleIdentity) return fallback;
  // Session cookie (web app) or bearer token, as verified by the throttler guard
  const token = extractSessionToken({
    headers: req.headers ?? {},
    cookies: req.cookies,
  });
  const payload = token?.split('.')[1];
  if (!payload) return fallback;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { sub?: unknown };
    return typeof claims.sub === 'string' && claims.sub
      ? `user:${claims.sub}`
      : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Per-user, per-route limit for expensive authenticated endpoints (report runs,
 * export jobs, imports): HEAVY_THROTTLE_LIMIT per HEAVY_THROTTLE_TTL seconds
 * (default 20/min). Applies on top of the per-store limit.
 */
export const UserThrottle = (limits = heavyThrottle) =>
  Throttle({
    default: {
      ttl: limits.ttl,
      limit: limits.limit,
      getTracker: (req) => userThrottleTracker(req as TrackedRequest),
    },
  });
