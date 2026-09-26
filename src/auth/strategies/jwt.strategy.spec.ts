import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { User } from '../../database/entities/user.entity';
import type { TenantMembership } from '../../database/entities/tenant-membership.entity';
import type { TenantRole } from '../../database/entities/tenant-role.entity';
import type { SessionsService } from '../../sessions/sessions.service';
import type { SettingsService } from '../../settings/settings.service';
import type { JwtPayload } from '../auth.service';
import { JwtStrategy } from './jwt.strategy';

describe('JwtStrategy', () => {
  const users = { findOne: jest.fn() };
  const strategy = new JwtStrategy(
    users as unknown as Repository<User>,
    { findOne: jest.fn() } as unknown as Repository<TenantMembership>,
    { findOne: jest.fn() } as unknown as Repository<TenantRole>,
    {
      get: () => 'a-test-secret-that-is-long-enough-1234567890',
    } as unknown as ConfigService,
    { check: jest.fn() } as unknown as SessionsService,
    { getSettings: jest.fn() } as unknown as SettingsService,
  );

  it.each([
    [
      'a manager approval token',
      { sub: 'manager', typ: 'approval', jti: 'j1', permission: 'sales.void' },
    ],
    [
      "the password step's temporary MFA token",
      { sub: 'u1', mfaVerified: false, typ: 'mfa_pending' },
    ],
    ['a token without a session', { sub: 'u1', mfaVerified: true }],
  ])('refuses %s as a sign-in token', async (_label, payload) => {
    await expect(
      strategy.validate(payload as unknown as JwtPayload),
    ).rejects.toThrow(UnauthorizedException);
    // Refused before anything is looked up
    expect(users.findOne).not.toHaveBeenCalled();
  });
});
