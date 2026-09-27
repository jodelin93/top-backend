import { isStrictEnv } from './environment';
import { validateEnv } from './env.validation';

describe('isStrictEnv', () => {
  it('is lax only in development and test', () => {
    expect(isStrictEnv('development')).toBe(false);
    expect(isStrictEnv('test')).toBe(false);
    expect(isStrictEnv('production')).toBe(true);
    expect(isStrictEnv('staging')).toBe(true);
    expect(isStrictEnv('prod')).toBe(true);
  });

  it('treats an unset NODE_ENV as development (the schema default)', () => {
    expect(isStrictEnv('')).toBe(false);
  });
});

describe('env validation in strict environments', () => {
  const base = {
    DB_HOST: 'localhost',
    DB_USERNAME: 'pos',
    DB_PASSWORD: 'pos',
    DB_DATABASE: 'pos',
  };

  it('requires secrets and CORS origins in staging, like production', () => {
    for (const NODE_ENV of ['staging', 'production']) {
      expect(() => validateEnv({ ...base, NODE_ENV })).toThrow(
        /JWT_SECRET[\s\S]*OFFLINE_LEASE_SECRET|CORS_ORIGINS/,
      );
    }
  });

  it('requires GIFT_CARD_CODE_SECRET in strict environments', () => {
    const complete = {
      ...base,
      NODE_ENV: 'production',
      JWT_SECRET: 'j'.repeat(48),
      OFFLINE_LEASE_SECRET: 'o'.repeat(48),
      CORS_ORIGINS: 'https://app.example.com',
    };
    expect(() => validateEnv(complete)).toThrow(/GIFT_CARD_CODE_SECRET/);
    expect(() =>
      validateEnv({ ...complete, GIFT_CARD_CODE_SECRET: 'g'.repeat(48) }),
    ).not.toThrow();
  });

  it('does not require them in development/test', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'test' })).not.toThrow();
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'development' }),
    ).not.toThrow();
  });
});
