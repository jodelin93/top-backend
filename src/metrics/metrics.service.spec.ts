import { metricsAccess } from './metrics.service';
import { routeLabel } from './http-metrics.middleware';
import type { Request } from 'express';

describe('metrics access', () => {
  const token = 'a-long-metrics-token-123';

  it('requires the bearer token when one is configured', () => {
    expect(metricsAccess(`Bearer ${token}`, { token })).toBe('allowed');
    expect(metricsAccess('Bearer wrong', { token })).toBe('unauthorized');
    expect(metricsAccess(undefined, { token })).toBe('unauthorized');
  });

  it('is open without a token in development/test only', () => {
    expect(metricsAccess(undefined, { nodeEnv: 'development' })).toBe(
      'allowed',
    );
    expect(metricsAccess(undefined, { nodeEnv: 'test' })).toBe('allowed');
    expect(metricsAccess(undefined, { nodeEnv: 'production' })).toBe(
      'disabled',
    );
    expect(metricsAccess(undefined, { nodeEnv: 'staging' })).toBe('disabled');
    // Strict environments always need the token
    expect(
      metricsAccess(undefined, { nodeEnv: 'production', enabled: 'true' }),
    ).toBe('disabled');
    expect(
      metricsAccess(`Bearer ${token}`, { token, nodeEnv: 'staging' }),
    ).toBe('allowed');
    expect(metricsAccess(`Bearer ${token}`, { token, enabled: 'false' })).toBe(
      'disabled',
    );
  });

  it('labels requests with the route pattern, not the URL', () => {
    expect(
      routeLabel({
        baseUrl: '',
        route: { path: '/api/v1/sales/:id' },
      } as unknown as Request),
    ).toBe('/api/v1/sales/:id');
    expect(routeLabel({ baseUrl: '' } as Request)).toBe('unmatched');
  });
});
