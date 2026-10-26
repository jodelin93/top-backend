import { dbSsl } from './db-ssl';

describe('dbSsl', () => {
  it('is off without DB_SSL, unchecked without a CA, checked with one', () => {
    expect(dbSsl({})).toBe(false);
    expect(dbSsl({ DB_SSL: 'true' })).toEqual({ rejectUnauthorized: false });
    expect(
      dbSsl({ DB_SSL: 'true', DB_SSL_REJECT_UNAUTHORIZED: 'true' }),
    ).toEqual({ rejectUnauthorized: true });
    expect(
      dbSsl({
        DB_SSL: 'true',
        DB_SSL_CA: '-----BEGIN CERTIFICATE-----\\nAA\\n',
      }),
    ).toEqual({
      ca: '-----BEGIN CERTIFICATE-----\nAA',
      rejectUnauthorized: true,
    });
  });
});
