import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Controller,
  Get,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  AuthService,
  JwtPayload,
  LoginResponse,
  StoreOption,
} from './auth.service';
import {
  ChangePasswordDto,
  LoginDto,
  MfaTokenDto,
  SwitchStoreDto,
} from './dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { MfaGuard } from './guards/mfa.guard';
import { PermissionsGuard } from './guards/permissions.guard';
import { AnyMember } from './decorators/permissions.decorator';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { AllowDuringMfaSetup } from './decorators/mfa-setup.decorator';
import { AuthThrottle } from './decorators/throttle.decorator';
import type { AuthUser } from './strategies/jwt.strategy';
import {
  clearSessionCookie,
  deliverMfaPending,
  deliverSession,
} from './session-cookie';

/**
 * Session tokens reach the web app only as HttpOnly cookies (session-cookie.ts);
 * the JSON keeps the user info. Clients sending `X-Auth-Mode: token` get the
 * token in the body instead (accessToken) and use Authorization: Bearer.
 */
type SessionResponse = Omit<LoginResponse, 'accessToken'> & {
  accessToken?: string;
};

@ApiTags('Authentication')
@ApiBearerAuth('JWT-auth')
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  /**
   * Login endpoint
   * POST /auth/login
   * Public endpoint - no authentication required
   */
  @Public()
  @AuthThrottle() // brute-force protection, per IP
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() loginDto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    const response = await this.authService.login(
      loginDto.email,
      loginDto.password,
    );
    // Second factor pending: the temporary token goes into the short-lived,
    // verify-only pos_mfa cookie
    return response.requiresMfa
      ? deliverMfaPending(req, res, response)
      : deliverSession(req, res, response);
  }

  /**
   * Verify MFA token and get full access token
   * POST /auth/mfa/verify
   * Requires temporary token (from login with MFA enabled)
   */
  // Not a session route: MfaGuard checks the temporary token from login
  @Public()
  @UseGuards(MfaGuard)
  @AuthThrottle() // brute-force protection, per IP
  @Post('mfa/verify')
  @HttpCode(HttpStatus.OK)
  async verifyMfa(
    @Req() req: Request & { user: JwtPayload },
    @Body() mfaTokenDto: MfaTokenDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    return deliverSession(
      req,
      res,
      await this.authService.verifyMfaToken(req.user.sub, mfaTokenDto.token),
    );
  }

  /**
   * Enable MFA for current user
   * POST /auth/mfa/enable
   * Returns QR code and secret for authenticator app setup
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @AnyMember()
  @AllowDuringMfaSetup()
  @Post('mfa/enable')
  @HttpCode(HttpStatus.OK)
  async enableMfa(
    @CurrentUser() user: AuthUser,
  ): Promise<{ secret: string; qrCode: string }> {
    return this.authService.enableMfa(user.id);
  }

  /**
   * Confirm MFA setup by verifying a token
   * POST /auth/mfa/confirm
   * Activates MFA and returns a new, unrestricted access token for this session
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @AnyMember()
  @AllowDuringMfaSetup()
  @AuthThrottle()
  @Post('mfa/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmMfa(
    @CurrentUser() user: AuthUser,
    @Body() mfaTokenDto: MfaTokenDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{
    success: boolean;
    message: string;
    session?: SessionResponse;
  }> {
    const success = await this.authService.confirmMfa(
      user.id,
      mfaTokenDto.token,
    );
    const reissued = await this.authService.afterMfaEnabled(user);
    const session = reissued && deliverSession(req, res, reissued);

    return {
      success,
      message: 'MFA has been enabled successfully',
      ...(session && { session }),
    };
  }

  /**
   * Stores that added this account and wait for it to accept
   * GET /auth/invitations
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @AnyMember()
  @Get('invitations')
  async invitations(@CurrentUser() user: AuthUser): Promise<StoreOption[]> {
    return this.authService.listInvitations(user.id);
  }

  /** POST /auth/invitations/:tenantId/accept | decline */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @AnyMember()
  @Post('invitations/:tenantId/:answer')
  @HttpCode(HttpStatus.NO_CONTENT)
  async answerInvitation(
    @CurrentUser() user: AuthUser,
    @Param('tenantId', ParseUUIDPipe) tenantId: string,
    @Param('answer', new ParseEnumPipe(['accept', 'decline']))
    answer: 'accept' | 'decline',
  ): Promise<void> {
    await this.authService.answerInvitation(
      user.id,
      tenantId,
      answer === 'accept',
    );
  }

  /**
   * Change one's own password (the current one is required)
   * POST /auth/password
   * Every other session of the account is signed out
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @AnyMember()
  @AllowDuringMfaSetup()
  @AuthThrottle()
  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  async changePassword(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangePasswordDto,
  ): Promise<void> {
    await this.authService.changePassword(
      user,
      dto.currentPassword,
      dto.newPassword,
    );
  }

  /**
   * Disable MFA for current user
   * POST /auth/mfa/disable
   * Requires a current code; refused when the store requires MFA for the user's role
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @AnyMember()
  @AuthThrottle()
  @Post('mfa/disable')
  @HttpCode(HttpStatus.OK)
  async disableMfa(
    @CurrentUser() user: AuthUser,
    @Body() mfaTokenDto: MfaTokenDto,
  ): Promise<{ success: boolean; message: string }> {
    const success = await this.authService.disableMfa(
      user.id,
      mfaTokenDto.token,
      { tenantId: user.tenantId, permissions: user.permissions ?? [] },
    );

    return {
      success,
      message: 'MFA has been disabled successfully',
    };
  }

  /**
   * Get current user profile
   * POST /auth/me
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @AnyMember()
  @AllowDuringMfaSetup()
  @Post('me')
  @HttpCode(HttpStatus.OK)
  async getProfile(@CurrentUser() user: AuthUser) {
    return {
      ...(await this.authService.getUserInfo(user, user.tenantId)),
      locale: user.locale,
      timezone: user.timezone,
      status: user.status,
      lastLoginAt: user.lastLoginAt,
      sessionId: user.sessionId ?? null,
    };
  }

  /**
   * Sign out: revokes the current session (the token stops working at once)
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @AnyMember()
  @AllowDuringMfaSetup()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser() user: AuthUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logout(user);
    clearSessionCookie(req, res);
    return { success: true };
  }

  /**
   * Stores the signed-in user belongs to
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @AnyMember()
  @AllowDuringMfaSetup()
  @Get('stores')
  listStores(@CurrentUser() user: AuthUser): Promise<StoreOption[]> {
    return this.authService.listStores(user.id, user.tenantId);
  }

  /**
   * Continue this session in another store; returns a new access token
   */
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @AnyMember()
  @AllowDuringMfaSetup()
  @Post('switch-store')
  @HttpCode(HttpStatus.OK)
  async switchStore(
    @CurrentUser() user: AuthUser,
    @Body() dto: SwitchStoreDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SessionResponse> {
    return deliverSession(
      req,
      res,
      await this.authService.switchStore(user, dto.tenantId),
    );
  }
}
