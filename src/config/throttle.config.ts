/**
 * Rate-limit settings shared by the global ThrottlerModule and the stricter
 * per-route limits on the authentication endpoints.
 *
 * Values are read lazily (functions), because route decorators are evaluated
 * at import time, before ConfigModule has loaded the .env file.
 */
const num = (name: string, fallback: number): number => {
  const parsed = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** Throttling is on everywhere except under Jest (NODE_ENV=test), unless forced. */
export const isThrottleEnabled = (): boolean =>
  process.env.THROTTLE_ENABLED
    ? process.env.THROTTLE_ENABLED === 'true'
    : process.env.NODE_ENV !== 'test';

/**
 * Anonymous traffic: THROTTLE_LIMIT requests per THROTTLE_TTL seconds per client IP
 * (per route). Authenticated requests are counted per store instead (tenantThrottle).
 */
export const globalThrottle = {
  ttl: () => num('THROTTLE_TTL', 60) * 1000,
  limit: () => num('THROTTLE_LIMIT', 300),
};

/**
 * Authenticated traffic: TENANT_THROTTLE_LIMIT requests per TENANT_THROTTLE_TTL seconds
 * per store (JWT tenant), across all routes. Generous, because every till and back-office
 * user of a store shares it, often behind one public IP.
 */
export const tenantThrottle = {
  ttl: () => num('TENANT_THROTTLE_TTL', 60) * 1000,
  limit: () => num('TENANT_THROTTLE_LIMIT', 3000),
};

/**
 * Store sign-up: SIGNUP_THROTTLE_LIMIT attempts per SIGNUP_THROTTLE_TTL seconds per IP.
 */
export const signupThrottle = {
  ttl: () => num('SIGNUP_THROTTLE_TTL', 3600) * 1000,
  limit: () => num('SIGNUP_THROTTLE_LIMIT', 5),
};

/**
 * Brute-force protection for credential/OTP endpoints:
 * AUTH_THROTTLE_LIMIT attempts per AUTH_THROTTLE_TTL seconds per client IP.
 * Usage: @Throttle({ default: authThrottle })
 */
export const authThrottle = {
  ttl: () => num('AUTH_THROTTLE_TTL', 60) * 1000,
  limit: () => num('AUTH_THROTTLE_LIMIT', 10),
};

/**
 * Expensive authenticated work (report runs, export jobs, CSV imports):
 * HEAVY_THROTTLE_LIMIT requests per HEAVY_THROTTLE_TTL seconds per user and route.
 * Usage: @UserThrottle() (common/throttle/user-throttle.decorator.ts)
 */
export const heavyThrottle = {
  ttl: () => num('HEAVY_THROTTLE_TTL', 60) * 1000,
  limit: () => num('HEAVY_THROTTLE_LIMIT', 20),
};
