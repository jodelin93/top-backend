import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import type { AuthUser } from './strategies/jwt.strategy';
import type { JwtPayload } from './auth.service';
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
    switchStore: jest.fn(),
    logout: jest.fn(),
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

  const expiresAt = new Date(Date.now() + 3600_000).toISOString();
  const browserReq = (headers: Record<string, string> = {}) =>
    ({ headers, secure: false }) as unknown as Request;
  const tokenReq = () => browserReq({ 'x-auth-mode': 'token' });
  // Express response double: the cookie calls are recorded on plain jest.fn()s
  const mockRes = () => {
    const cookie = jest.fn();
    const clearCookie = jest.fn();
    const res = { cookie, clearCookie } as unknown as Response;
    return Object.assign(res, { calls: { cookie, clearCookie } });
  };
  const cookieOptions = (fn: jest.Mock, call = 0) =>
    (fn.mock.calls[call] as [string, string, Record<string, unknown>])[2];

  it('logs in with the submitted credentials and sets the session cookie', async () => {
    authService.login.mockResolvedValue({
      accessToken: 'jwt',
      user: { id: 'u1' },
      requiresMfa: false,
      expiresAt,
    });
    const res = mockRes();
    const body = await controller.login(
      { email: 'a@example.com', password: 'secret' },
      browserReq(),
      res,
    );
    expect(authService.login).toHaveBeenCalledWith('a@example.com', 'secret');
    // The browser never sees the token
    expect(body).toEqual({ user: { id: 'u1' }, requiresMfa: false, expiresAt });
    expect(res.calls.cookie).toHaveBeenCalledWith(
      'pos_session',
      'jwt',
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'strict',
        secure: false,
        path: '/api/v1',
      }),
    );
    const maxAge = cookieOptions(res.calls.cookie).maxAge as number;
    expect(maxAge).toBeGreaterThan(3500_000);
    expect(maxAge).toBeLessThanOrEqual(3600_000);
  });

  it('marks the cookie Secure on HTTPS requests', async () => {
    authService.login.mockResolvedValue({ accessToken: 'jwt', expiresAt });
    const res = mockRes();
    await controller.login(
      { email: 'a@example.com', password: 'secret' },
      { headers: {}, secure: true } as unknown as Request,
      res,
    );
    expect(cookieOptions(res.calls.cookie)).toMatchObject({ secure: true });
  });

  it('returns the token in the body for token-mode clients, without a cookie', async () => {
    authService.login.mockResolvedValue({ accessToken: 'jwt', expiresAt });
    const res = mockRes();
    await expect(
      controller.login(
        { email: 'a@example.com', password: 'secret' },
        tokenReq(),
        res,
      ),
    ).resolves.toEqual({ accessToken: 'jwt', expiresAt });
    expect(res.calls.cookie).not.toHaveBeenCalled();
  });

  it('puts the temporary MFA token in a verify-only cookie', async () => {
    authService.login.mockResolvedValue({
      accessToken: 'temp',
      requiresMfa: true,
    });
    const res = mockRes();
    const body = await controller.login(
      { email: 'a@example.com', password: 'secret' },
      browserReq(),
      res,
    );
    expect(body).toEqual({ requiresMfa: true });
    expect(res.calls.cookie).toHaveBeenCalledWith(
      'pos_mfa',
      'temp',
      expect.objectContaining({
        httpOnly: true,
        path: '/api/v1/auth/mfa/verify',
        maxAge: 300_000,
      }),
    );
    // An older session on this browser is dropped
    expect(res.calls.clearCookie).toHaveBeenCalledWith(
      'pos_session',
      expect.objectContaining({ path: '/api/v1' }),
    );
  });

  it('verifies MFA for the user in the temporary token and starts the session', async () => {
    authService.verifyMfaToken.mockResolvedValue({ accessToken: 'full' });
    const res = mockRes();
    const req = {
      headers: { cookie: 'pos_mfa=temp' },
      user: { sub: 'u1', email: 'a@example.com' },
    } as unknown as Request & { user: JwtPayload };
    await expect(
      controller.verifyMfa(req, { token: '123456' }, res),
    ).resolves.toEqual({});
    expect(authService.verifyMfaToken).toHaveBeenCalledWith('u1', '123456');
    expect(res.calls.cookie).toHaveBeenCalledWith(
      'pos_session',
      'full',
      expect.anything(),
    );
    expect(res.calls.clearCookie).toHaveBeenCalledWith(
      'pos_mfa',
      expect.objectContaining({ path: '/api/v1/auth/mfa/verify' }),
    );
  });

  it('wraps the MFA confirmation result and re-issues the cookie', async () => {
    authService.confirmMfa.mockResolvedValue(true);
    authService.afterMfaEnabled.mockResolvedValue({ accessToken: 'full' });
    const res = mockRes();
    await expect(
      controller.confirmMfa(
        { id: 'u1' } as AuthUser,
        { token: '123456' },
        browserReq(),
        res,
      ),
    ).resolves.toEqual({
      success: true,
      message: 'MFA has been enabled successfully',
      session: {},
    });
    expect(res.calls.cookie).toHaveBeenCalledWith(
      'pos_session',
      'full',
      expect.anything(),
    );
  });

  it('switches store with a new session cookie', async () => {
    authService.switchStore.mockResolvedValue({
      accessToken: 'store2',
      user: { tenantId: 't2' },
    });
    const res = mockRes();
    await expect(
      controller.switchStore(
        { id: 'u1' } as AuthUser,
        { tenantId: 't2' },
        browserReq(),
        res,
      ),
    ).resolves.toEqual({ user: { tenantId: 't2' } });
    expect(res.calls.cookie).toHaveBeenCalledWith(
      'pos_session',
      'store2',
      expect.anything(),
    );
  });

  it('revokes the session and clears the cookie on logout', async () => {
    const res = mockRes();
    await expect(
      controller.logout({ id: 'u1' } as AuthUser, browserReq(), res),
    ).resolves.toEqual({ success: true });
    expect(authService.logout).toHaveBeenCalled();
    expect(res.calls.clearCookie).toHaveBeenCalledWith(
      'pos_session',
      expect.objectContaining({ path: '/api/v1', httpOnly: true }),
    );
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
