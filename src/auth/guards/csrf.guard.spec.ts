import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CsrfGuard } from './csrf.guard';

describe('CsrfGuard', () => {
  const reflector = { getAllAndOverride: jest.fn() };
  const guard = new CsrfGuard(reflector as unknown as Reflector);

  const context = (req: { method: string; headers: Record<string, string> }) =>
    ({
      getType: () => 'http',
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

  const check = (method: string, headers: Record<string, string> = {}) =>
    guard.canActivate(context({ method, headers }));

  beforeEach(() => reflector.getAllAndOverride.mockReturnValue(undefined));

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'refuses a cookie-authenticated %s without the header (403)',
    (method) => {
      expect(() => check(method, { cookie: 'pos_session=jwt' })).toThrow(
        ForbiddenException,
      );
    },
  );

  it('accepts a cookie-authenticated request with the web app header', () => {
    expect(
      check('POST', {
        cookie: 'pos_session=jwt',
        'x-requested-with': 'pos-web',
      }),
    ).toBe(true);
  });

  it('refuses the wrong header value', () => {
    expect(() =>
      check('POST', {
        cookie: 'pos_session=jwt',
        'x-requested-with': 'XMLHttpRequest',
      }),
    ).toThrow(ForbiddenException);
  });

  it('lets safe methods through', () => {
    expect(check('GET', { cookie: 'pos_session=jwt' })).toBe(true);
    expect(check('HEAD', { cookie: 'pos_session=jwt' })).toBe(true);
    expect(check('OPTIONS')).toBe(true);
  });

  it('exempts bearer-authenticated requests', () => {
    expect(check('POST', { authorization: 'Bearer jwt' })).toBe(true);
    expect(check('DELETE', { authorization: 'Bearer jwt' })).toBe(true);
  });

  it('still checks a bearer request that also carries the session cookie', () => {
    expect(() =>
      check('POST', {
        authorization: 'Bearer jwt',
        cookie: 'pos_session=jwt',
      }),
    ).toThrow(ForbiddenException);
  });

  it('protects anonymous requests such as sign-in (login CSRF)', () => {
    expect(() => check('POST')).toThrow(ForbiddenException);
    expect(check('POST', { 'x-requested-with': 'pos-web' })).toBe(true);
    // API clients asking for a token in the body send a custom header too
    expect(check('POST', { 'x-auth-mode': 'token' })).toBe(true);
  });

  it('skips endpoints marked @SkipCsrf (webhooks)', () => {
    reflector.getAllAndOverride.mockReturnValue(true);
    expect(check('POST')).toBe(true);
  });
});
