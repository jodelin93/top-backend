import { redactPath } from './request-logging.middleware';

describe('redactPath', () => {
  it('replaces capability tokens in signed download and receipt links', () => {
    expect(redactPath('/api/v1/exports/download/eyJhbGci.abc.def')).toBe(
      '/api/v1/exports/download/:token',
    );
    expect(redactPath('/api/v1/public/receipts/abc123?lang=fr')).toBe(
      '/api/v1/public/receipts/:token',
    );
  });

  it('drops the query string and leaves other paths alone', () => {
    expect(redactPath('/api/v1/sales/42?search=x')).toBe('/api/v1/sales/42');
    expect(redactPath('/api/v1/exports')).toBe('/api/v1/exports');
  });
});
