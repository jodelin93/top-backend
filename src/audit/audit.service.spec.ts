import { ForbiddenException } from '@nestjs/common';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { AuditController } from './audit.controller';
import { AuditService, isSecretKey, scrub } from './audit.service';

describe('audit redaction', () => {
  it.each([
    'password',
    'passwordHash',
    'PASSWORD',
    'newPassword',
    'mfaSecret',
    'token',
    'approvalToken',
    'refresh_token',
    'accessToken',
    'pin',
    'PIN',
    'pinHash',
    'otp',
    'otpCode',
    'mfaCode',
    'mfa_code',
    'cardNumber',
    'card_number',
    'cvv',
    'CVV',
    'authorization',
    'Authorization',
    'apiKey',
    'x-api-key',
    'APIKey',
    'lease',
    'offlineLease',
  ])('treats %s as a secret', (key) => {
    expect(isSecretKey(key)).toBe(true);
  });

  it.each([
    'shippingAddress',
    'passed',
    'releasedAt',
    'spinner',
    'opinion',
    'email',
    'amount',
    'takeCount',
  ])('keeps %s', (key) => {
    expect(isSecretKey(key)).toBe(false);
  });

  it('removes secrets at any depth, whatever their case', () => {
    expect(
      scrub({
        user: { email: 'a@b.c', PasswordHash: 'x', devices: [{ PIN: '1234' }] },
        headers: { Authorization: 'Bearer abc', 'X-Api-Key': 'k' },
        passed: true,
      }),
    ).toEqual({
      user: { email: 'a@b.c', devices: [{}] },
      headers: {},
      passed: true,
    });
  });

  it('does not store values nested too deep to check', () => {
    let deep: Record<string, unknown> = { password: 'x' };
    for (let i = 0; i < 12; i++) deep = { next: deep };
    expect(JSON.stringify(scrub(deep))).not.toContain('password');
  });
});

describe('GET /audit-logs', () => {
  const service = { list: jest.fn(() => Promise.resolve({ data: [] })) };
  const controller = new AuditController(service as unknown as AuditService);

  it('needs access to every branch', () => {
    const limited = { id: 'u1', branchIds: ['b1'] } as unknown as AuthUser;
    expect(() => controller.list('t1', limited, {})).toThrow(
      ForbiddenException,
    );
    expect(service.list).not.toHaveBeenCalled();
  });

  it('lists for every-branch members', async () => {
    const all = { id: 'u1', branchIds: null } as unknown as AuthUser;
    await controller.list('t1', all, {});
    expect(service.list).toHaveBeenCalledWith('t1', {});
  });
});
