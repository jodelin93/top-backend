import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ThrottlerRequest, ThrottlerStorage } from '@nestjs/throttler';
import {
  TENANT_THROTTLER,
  TenantThrottlerGuard,
  throttleIdentity,
} from './tenant-throttler.guard';
import { IP_THROTTLE_KEY } from '../decorators/throttle.decorator';
import type { JwtPayload } from '../auth.service';

const verify = (token: string): JwtPayload => {
  if (token === 'bad') throw new Error('invalid signature');
  return JSON.parse(token) as JwtPayload;
};

describe('throttleIdentity', () => {
  it('counts a store token against its store', () => {
    expect(
      throttleIdentity(
        `Bearer ${JSON.stringify({ sub: 'u1', tid: 't1' })}`,
        verify,
      ),
    ).toBe('tenant:t1');
  });

  it('counts an older token without a store against the user', () => {
    expect(
      throttleIdentity(`Bearer ${JSON.stringify({ sub: 'u1' })}`, verify),
    ).toBe('user:u1');
  });

  it('treats missing or invalid tokens as anonymous (per IP)', () => {
    expect(throttleIdentity(undefined, verify)).toBeNull();
    expect(throttleIdentity('Bearer bad', verify)).toBeNull();
    expect(throttleIdentity('Basic abc', verify)).toBeNull();
  });
});

describe('TenantThrottlerGuard', () => {
  const increments: string[] = [];
  const storage: ThrottlerStorage = {
    increment: jest.fn((key: string) => {
      increments.push(key);
      return Promise.resolve({
        totalHits: 1,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      });
    }),
  };
  const reflector = new Reflector();
  const jwt = { verify } as unknown as JwtService;
  const guard = new TenantThrottlerGuard(
    { throttlers: [] },
    storage,
    reflector,
    jwt,
  );

  const context = (authorization?: string, perIp = false): ExecutionContext => {
    const req = { headers: { authorization }, ip: '203.0.113.9' };
    const res = { header: jest.fn() };
    jest
      .spyOn(reflector, 'getAllAndOverride')
      .mockImplementation((key) =>
        key === IP_THROTTLE_KEY ? perIp : undefined,
      );
    return {
      getHandler: () => function handler() {},
      getClass: () => class Ctrl {},
      switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    } as unknown as ExecutionContext;
  };

  const run = (ctx: ExecutionContext, name: string) =>
    (
      guard as unknown as {
        handleRequest(p: ThrottlerRequest): Promise<boolean>;
      }
    ).handleRequest({
      context: ctx,
      limit: 10,
      ttl: 60_000,
      blockDuration: 60_000,
      throttler: { name, limit: 10, ttl: 60_000 },
      getTracker: (req: Record<string, unknown>) =>
        Promise.resolve(String(req.ip)),
      generateKey: (_c, tracker, n) => `${n}:${tracker}`,
    });

  beforeAll(() => guard.onModuleInit());

  beforeEach(() => {
    increments.length = 0;
    jest.restoreAllMocks();
  });

  const storeToken = `Bearer ${JSON.stringify({ sub: 'u1', tid: 't1' })}`;

  it('uses one bucket per store for authenticated requests', async () => {
    await run(context(storeToken), 'default');
    await run(context(storeToken), TENANT_THROTTLER);
    expect(increments).toEqual([`${TENANT_THROTTLER}:tenant:t1`]);
  });

  it('counts anonymous requests per IP only', async () => {
    await run(context(undefined), 'default');
    await run(context(undefined), TENANT_THROTTLER);
    expect(increments).toEqual(['default:203.0.113.9']);
  });

  it('keeps the strict per-IP limit on credential endpoints, even with a token', async () => {
    await run(context(storeToken, true), 'default');
    expect(increments).toEqual(['default:203.0.113.9']);
  });
});
