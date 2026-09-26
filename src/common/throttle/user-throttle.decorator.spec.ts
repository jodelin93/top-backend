import { userThrottleTracker } from './user-throttle.decorator';

const token = (claims: object) =>
  `Bearer h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('userThrottleTracker', () => {
  it('tracks verified requests per user', () => {
    expect(
      userThrottleTracker({
        ip: '1.2.3.4',
        throttleIdentity: 'tenant:t1',
        headers: { authorization: token({ sub: 'u1', tid: 't1' }) },
      }),
    ).toBe('user:u1');
  });

  it('falls back to the IP when the token was not verified', () => {
    expect(
      userThrottleTracker({
        ip: '1.2.3.4',
        throttleIdentity: null,
        headers: { authorization: token({ sub: 'forged' }) },
      }),
    ).toBe('ip:1.2.3.4');
    expect(
      userThrottleTracker({
        ip: '1.2.3.4',
        throttleIdentity: 'tenant:t1',
        headers: { authorization: 'Bearer garbage' },
      }),
    ).toBe('ip:1.2.3.4');
  });
});
