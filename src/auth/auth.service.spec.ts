import { ALL_PERMISSIONS } from './permissions';
import { TenantRole } from '../database/entities/tenant-role.entity';
import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import * as speakeasy from 'speakeasy';
import { User, UserStatus } from '../database/entities/user.entity';
import {
  MembershipRole,
  TenantMembership,
} from '../database/entities/tenant-membership.entity';
import { AuthService } from './auth.service';
import { SessionsService } from '../sessions/sessions.service';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';

describe('AuthService', () => {
  let service: AuthService;
  let passwordHash: string;

  // Last two-factor step used, as the users row would hold it
  let lastStep: number | null = null;
  const userRepository = {
    findOne: jest.fn(),
    update: jest.fn(),
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.includes('"mfaLastUsedStep" = $2')) {
        const step = params[1] as number;
        if (lastStep !== null && lastStep >= step)
          return Promise.resolve([[], 0]);
        lastStep = step;
        return Promise.resolve([[{ id: params[0] }], 1]);
      }
      return Promise.resolve([[], 0]);
    }),
  };
  const membershipRepository = {
    findOne: jest.fn(),
    find: jest.fn(() => Promise.resolve([{ tenantId: 't1' }])),
  };
  const auditService = { record: jest.fn() };
  const jwtService = {
    sign: jest.fn((payload: object) => `token:${JSON.stringify(payload)}`),
    decode: jest.fn(() => ({ exp: Math.floor(Date.now() / 1000) + 3600 })),
  };
  const sessionsService = {
    newId: jest.fn(() => 'sid-1'),
    create: jest.fn(),
    setTenant: jest.fn(),
    revokeOwn: jest.fn(),
    revokeAllForUser: jest.fn(),
  };
  const settings = { requireMfaForAdmins: false };
  const settingsService = {
    getSettings: jest.fn(() => Promise.resolve(settings)),
  };

  const user = (extra: Partial<User> = {}) =>
    ({
      id: 'u1',
      email: 'owner@example.com',
      firstName: 'Olga',
      lastName: 'Owner',
      passwordHash,
      status: UserStatus.ACTIVE,
      mfaEnabled: false,
      ...extra,
    }) as User;

  beforeAll(async () => {
    passwordHash = await bcrypt.hash('Password123!', 4);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    lastStep = null;
    settings.requireMfaForAdmins = false;
    membershipRepository.findOne.mockResolvedValue({
      tenantId: 't1',
      role: MembershipRole.OWNER,
    });
    const module = await Test.createTestingModule({
      providers: [
        {
          provide: getRepositoryToken(TenantRole),
          useValue: { findOne: jest.fn(() => Promise.resolve(null)) },
        },
        AuthService,
        { provide: getRepositoryToken(User), useValue: userRepository },
        {
          provide: getRepositoryToken(TenantMembership),
          useValue: membershipRepository,
        },
        { provide: JwtService, useValue: jwtService },
        { provide: SessionsService, useValue: sessionsService },
        { provide: SettingsService, useValue: settingsService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();
    service = module.get(AuthService);
  });

  describe('login', () => {
    it('returns a full token and the user with their store role', async () => {
      userRepository.findOne.mockResolvedValue(user());
      const result = await service.login('owner@example.com', 'Password123!');

      expect(result.requiresMfa).toBe(false);
      expect(result.mfaSetupRequired).toBe(false);
      // The token names its session and store
      expect(jwtService.sign).toHaveBeenCalledWith({
        sub: 'u1',
        email: 'owner@example.com',
        mfaVerified: true,
        sid: 'sid-1',
        tid: 't1',
      });
      expect(sessionsService.create).toHaveBeenCalledWith('sid-1', {
        userId: 'u1',
        tenantId: 't1',
        expiresAt: expect.any(Date) as Date,
        authMethod: 'password',
      });
      expect(result.user).toMatchObject({
        id: 'u1',
        email: 'owner@example.com',
        firstName: 'Olga',
        lastName: 'Owner',
        mfaEnabled: false,
        tenantId: 't1',
        role: MembershipRole.OWNER,
      });
      // Owners always hold every permission
      expect(result.user.permissions).toEqual(ALL_PERMISSIONS);
      expect(userRepository.update).toHaveBeenCalledWith('u1', {
        lastLoginAt: expect.any(Date) as Date,
      });
    });

    it('rejects a wrong password', async () => {
      userRepository.findOne.mockResolvedValue(user());
      await expect(
        service.login('owner@example.com', 'wrong-password'),
      ).rejects.toThrow(UnauthorizedException);
      expect(jwtService.sign).not.toHaveBeenCalled();
    });

    it('rejects an unknown email', async () => {
      userRepository.findOne.mockResolvedValue(null);
      await expect(service.login('nobody@example.com', 'x')).rejects.toThrow(
        'Invalid credentials',
      );
    });

    it('rejects a suspended account even with the right password', async () => {
      userRepository.findOne.mockResolvedValue(
        user({ status: 'suspended' as UserStatus }),
      );
      await expect(
        service.login('owner@example.com', 'Password123!'),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('only hands out a short-lived, unverified token when MFA is on', async () => {
      userRepository.findOne.mockResolvedValue(user({ mfaEnabled: true }));
      const result = await service.login('owner@example.com', 'Password123!');

      expect(result.requiresMfa).toBe(true);
      expect(jwtService.sign).toHaveBeenCalledWith(
        {
          sub: 'u1',
          email: 'owner@example.com',
          mfaVerified: false,
          typ: 'mfa_pending',
        },
        { expiresIn: '5m' },
      );
      expect(userRepository.update).not.toHaveBeenCalled();
      expect(sessionsService.create).not.toHaveBeenCalled();
    });

    it('gives privileged users a restricted token when the store requires two-factor', async () => {
      settings.requireMfaForAdmins = true;
      userRepository.findOne.mockResolvedValue(user());
      const result = await service.login('owner@example.com', 'Password123!');

      expect(result.mfaSetupRequired).toBe(true);
      expect(result.user.mfaSetupRequired).toBe(true);
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ scope: 'mfa_setup', sid: 'sid-1' }),
      );
    });
  });

  describe('sessions', () => {
    it('logout revokes the current session', async () => {
      await service.logout({ id: 'u1', sessionId: 's1', tenantId: 't1' });
      expect(sessionsService.revokeOwn).toHaveBeenCalledWith(
        'u1',
        's1',
        'logout',
        't1',
      );
    });

    it('switching store keeps the session and re-issues the token for that store', async () => {
      membershipRepository.findOne.mockResolvedValue({
        tenantId: 't2',
        role: MembershipRole.OWNER,
        tenant: { status: 'active', name: 'Second' },
      });
      const result = await service.switchStore(
        Object.assign(user(), { sessionId: 's1', tenantId: 't1' }),
        't2',
      );
      expect(result.user.tenantId).toBe('t2');
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sid: 's1', tid: 't2' }),
      );
      expect(sessionsService.setTenant).toHaveBeenCalledWith(
        's1',
        'u1',
        't2',
        expect.any(Date),
      );
    });

    it('refuses to switch to a store the user does not belong to', async () => {
      membershipRepository.findOne.mockResolvedValue(null);
      await expect(
        service.switchStore(
          Object.assign(user(), { sessionId: 's1', tenantId: 't1' }),
          't9',
        ),
      ).rejects.toThrow('You are not a member of this store');
    });
  });

  describe('verifyMfaToken', () => {
    const secret = speakeasy.generateSecret({ length: 20 }).base32;

    it('issues a full token for a valid code', async () => {
      userRepository.findOne.mockResolvedValue(
        user({ mfaEnabled: true, mfaSecret: secret }),
      );
      const code = speakeasy.totp({ secret, encoding: 'base32' });
      const result = await service.verifyMfaToken('u1', code);
      expect(result.requiresMfa).toBe(false);
      expect(jwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({ mfaVerified: true }),
      );
    });

    it('rejects a wrong code', async () => {
      userRepository.findOne.mockResolvedValue(
        user({ mfaEnabled: true, mfaSecret: secret }),
      );
      await expect(service.verifyMfaToken('u1', '000000')).rejects.toThrow(
        'Invalid MFA token',
      );
    });

    it('accepts a code only once (no replay)', async () => {
      userRepository.findOne.mockResolvedValue(
        user({ mfaEnabled: true, mfaSecret: secret }),
      );
      const code = speakeasy.totp({ secret, encoding: 'base32' });
      await service.verifyMfaToken('u1', code);
      await expect(service.verifyMfaToken('u1', code)).rejects.toThrow(
        'Invalid MFA token',
      );
    });

    it('counts a wrong code towards the lockout and audits it', async () => {
      userRepository.findOne.mockResolvedValue(
        user({ mfaEnabled: true, mfaSecret: secret }),
      );
      await expect(service.verifyMfaToken('u1', '000000')).rejects.toThrow();
      expect(userRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('"failedLoginCount" + 1'),
        expect.arrayContaining(['u1']),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.mfa_failed' }),
      );
    });

    it('rejects users without MFA', async () => {
      userRepository.findOne.mockResolvedValue(user());
      await expect(service.verifyMfaToken('u1', '123456')).rejects.toThrow(
        'MFA not enabled',
      );
    });
  });

  describe('lockout', () => {
    it('refuses a locked account before checking the password', async () => {
      userRepository.findOne.mockResolvedValue(
        user({ lockedUntil: new Date(Date.now() + 60_000) }),
      );
      await expect(
        service.login('owner@example.com', 'Password123!'),
      ).rejects.toThrow(/locked/);
    });

    it('counts a wrong password and clears the count on success', async () => {
      userRepository.findOne.mockResolvedValue(user());
      await expect(
        service.login('owner@example.com', 'wrong-password'),
      ).rejects.toThrow('Invalid credentials');
      expect(userRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('"failedLoginCount" + 1'),
        expect.arrayContaining(['u1']),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'auth.login_failed' }),
      );
      await service.login('owner@example.com', 'Password123!');
      expect(userRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('"failedLoginCount" = 0'),
        ['u1'],
      );
    });
  });

  describe('account security', () => {
    it('will not replace the secret of an active second factor', async () => {
      userRepository.findOne.mockResolvedValue(user({ mfaEnabled: true }));
      await expect(service.enableMfa('u1')).rejects.toThrow(/already on/);
      expect(userRepository.update).not.toHaveBeenCalled();
    });

    it('changes the password only with the current one, signing out other sessions', async () => {
      userRepository.findOne.mockResolvedValue(user());
      const me = { id: 'u1', sessionId: 's1', tenantId: 't1' };
      await expect(
        service.changePassword(me, 'wrong-password', 'NewPassword1!'),
      ).rejects.toThrow('Your current password is incorrect');
      expect(userRepository.update).not.toHaveBeenCalled();

      await service.changePassword(me, 'Password123!', 'NewPassword1!');
      const [, changed] = userRepository.update.mock.calls[0] as [
        string,
        { passwordHash: string },
      ];
      await expect(
        bcrypt.compare('NewPassword1!', changed.passwordHash),
      ).resolves.toBe(true);
      expect(sessionsService.revokeAllForUser).toHaveBeenCalledWith(
        'u1',
        'password_changed',
        { exceptSessionId: 's1' },
      );
    });
  });

  it('reports no tenant or role for a user without an active membership', async () => {
    membershipRepository.findOne.mockResolvedValue(null);
    await expect(service.getUserInfo(user())).resolves.toMatchObject({
      tenantId: null,
      role: null,
    });
  });
});
