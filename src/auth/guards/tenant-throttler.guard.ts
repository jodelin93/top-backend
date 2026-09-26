import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerRequest,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { JwtPayload } from '../auth.service';
import { IP_THROTTLE_KEY } from '../decorators/throttle.decorator';

export const TENANT_THROTTLER = 'tenant';

// Metadata key @Throttle({ default: ... }) writes (THROTTLER_LIMIT + name in @nestjs/throttler)
const DEFAULT_LIMIT_OVERRIDE_KEY = 'THROTTLER:LIMIT' + 'default';

/**
 * Who a request is counted against: the store (tid claim) for a valid access token,
 * the user for older tokens without a store, or null (anonymous → per IP).
 */
export function throttleIdentity(
  authorization: string | undefined,
  verify: (token: string) => JwtPayload,
): string | null {
  const [type, token] = authorization?.split(' ') ?? [];
  if (type !== 'Bearer' || !token) return null;
  try {
    const payload = verify(token);
    if (payload.tid) return `tenant:${payload.tid}`;
    return payload.sub ? `user:${payload.sub}` : null;
  } catch {
    return null;
  }
}

/**
 * Global rate limiter:
 * - anonymous requests: the 'default' throttler, per client IP (and route);
 * - authenticated requests: the 'tenant' throttler, one bucket per store for all routes;
 * - routes with their own 'default' limit (@AuthThrottle(), @SignupThrottle(), or any
 *   @Throttle({ default })): always per IP, with that stricter limit.
 */
@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {
    super(options, storageService, reflector);
  }

  protected async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const { context, throttler } = props;
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      throttleIdentity?: string | null;
    }>();
    if (req.throttleIdentity === undefined) {
      req.throttleIdentity = throttleIdentity(req.headers.authorization, (t) =>
        this.jwtService.verify<JwtPayload>(t),
      );
    }
    const identity = req.throttleIdentity;
    // Routes with their own limit (credentials, approval passwords) stay per IP
    const targets = [context.getHandler(), context.getClass()];
    const perIp =
      !!this.reflector.getAllAndOverride<boolean>(IP_THROTTLE_KEY, targets) ||
      this.reflector.getAllAndOverride<unknown>(
        DEFAULT_LIMIT_OVERRIDE_KEY,
        targets,
      ) !== undefined;

    if (throttler.name === TENANT_THROTTLER) {
      if (!identity) return true;
      return super.handleRequest({
        ...props,
        getTracker: () => Promise.resolve(identity),
        // One bucket per store across every route
        generateKey: (_context, tracker, name) => `${name}:${tracker}`,
      });
    }

    if (identity && !perIp) return true;
    return super.handleRequest(props);
  }
}
