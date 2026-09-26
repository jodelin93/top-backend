import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { AuthUser } from './strategies/jwt.strategy';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ApprovalsService } from '../approvals/approvals.service';

describe('AuthController', () => {
  let controller: AuthController;
  const authService = {
    login: jest.fn(),
    verifyMfaToken: jest.fn(),
    confirmMfa: jest.fn(),
    afterMfaEnabled: jest.fn(),
    getUserInfo: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        // Needed by MfaGuard, which is instantiated with the controller
        { provide: JwtService, useValue: {} },
        // Needed by PermissionsGuard (approval tokens)
        { provide: ApprovalsService, useValue: {} },
      ],
    }).compile();
    controller = module.get(AuthController);
  });

  it('logs in with the submitted credentials', async () => {
    authService.login.mockResolvedValue({ accessToken: 'jwt' });
    await expect(
      controller.login({ email: 'a@example.com', password: 'secret' }),
    ).resolves.toEqual({ accessToken: 'jwt' });
    expect(authService.login).toHaveBeenCalledWith('a@example.com', 'secret');
  });

  it('verifies MFA for the user in the temporary token', async () => {
    await controller.verifyMfa(
      { user: { sub: 'u1', email: 'a@example.com' } },
      { token: '123456' },
    );
    expect(authService.verifyMfaToken).toHaveBeenCalledWith('u1', '123456');
  });

  it('wraps the MFA confirmation result', async () => {
    authService.confirmMfa.mockResolvedValue(true);
    authService.afterMfaEnabled.mockResolvedValue({ accessToken: 'full' });
    await expect(
      controller.confirmMfa({ id: 'u1' } as AuthUser, { token: '123456' }),
    ).resolves.toEqual({
      success: true,
      message: 'MFA has been enabled successfully',
      session: { accessToken: 'full' },
    });
  });

  it('adds profile fields to the user info', async () => {
    authService.getUserInfo.mockResolvedValue({ id: 'u1', role: 'owner' });
    const user = {
      id: 'u1',
      locale: 'en',
      timezone: 'UTC',
      status: 'active',
      lastLoginAt: null,
      tenantId: 't1',
      sessionId: 's1',
    } as unknown as AuthUser;
    await expect(controller.getProfile(user)).resolves.toEqual({
      id: 'u1',
      role: 'owner',
      locale: 'en',
      timezone: 'UTC',
      status: 'active',
      lastLoginAt: null,
      sessionId: 's1',
    });
    expect(authService.getUserInfo).toHaveBeenCalledWith(user, 't1');
  });
});
