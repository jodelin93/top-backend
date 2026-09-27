import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { SignupThrottle } from '../auth/decorators/throttle.decorator';
import { deliverSession } from '../auth/session-cookie';
import { TenantsService } from './tenants.service';
import { SignupDto } from './tenants.dto';

@ApiTags('Stores')
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  /** Whether the sign-up page should be offered (ALLOW_SIGNUP) */
  @Public()
  @Get('signup-enabled')
  signupEnabled() {
    return { enabled: this.tenantsService.isSignupEnabled() };
  }

  /**
   * Create a new store and its owner, and sign the owner in (HttpOnly session
   * cookie; the token is in the body only with X-Auth-Mode: token)
   */
  @Public()
  @SignupThrottle()
  @Post('signup')
  async signup(
    @Body() dto: SignupDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return deliverSession(req, res, await this.tenantsService.signup(dto));
  }
}
