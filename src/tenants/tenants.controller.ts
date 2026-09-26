import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/public.decorator';
import { SignupThrottle } from '../auth/decorators/throttle.decorator';
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

  /** Create a new store and its owner, and sign the owner in */
  @Public()
  @SignupThrottle()
  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.tenantsService.signup(dto);
  }
}
