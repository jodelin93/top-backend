import {
  cookieIsSecure,
  extractMfaToken,
  extractSessionToken,
  parseCookies,
} from './session-cookie';

describe('session cookie helpers', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('parses a Cookie header', () => {
    expect(parseCookies('a=1; pos_session=x.y.z; b="q%20r"; a=2')).toEqual({
      a: '1',
      pos_session: 'x.y.z',
      b: 'q r',
    });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('reads the session token from the cookie first, else the bearer header', () => {
    expect(
      extractSessionToken({
        headers: { authorization: 'Bearer bearer-token' },
        cookies: { pos_session: 'cookie-token' },
      }),
    ).toBe('cookie-token');
    expect(
      extractSessionToken({
        headers: {
          authorization: 'Bearer bearer-token',
          cookie: 'other=1',
        },
      }),
    ).toBe('bearer-token');
    expect(extractSessionToken({ headers: {} })).toBeNull();
    expect(
      extractSessionToken({ headers: { authorization: 'Basic abc' } }),
    ).toBeNull();
  });

  it('reads the temporary MFA token from its own cookie only', () => {
    expect(extractMfaToken({ headers: { cookie: 'pos_mfa=temp' } })).toBe(
      'temp',
    );
    expect(
      extractMfaToken({ headers: { cookie: 'pos_session=session' } }),
    ).toBeUndefined();
  });

  it('marks cookies Secure on HTTPS or in strict environments only', () => {
    delete process.env.AUTH_COOKIE_SECURE;
    process.env.NODE_ENV = 'development';
    expect(cookieIsSecure({ headers: {}, secure: false })).toBe(false);
    expect(cookieIsSecure({ headers: {}, secure: true })).toBe(true);
    process.env.NODE_ENV = 'production';
    expect(cookieIsSecure({ headers: {}, secure: false })).toBe(true);
    process.env.AUTH_COOKIE_SECURE = 'false';
    expect(cookieIsSecure({ headers: {}, secure: true })).toBe(false);
  });
});
