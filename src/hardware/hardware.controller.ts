import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  AnyMember,
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { requestContext } from '../common/context/request-context';
import { HardwareService } from './hardware.service';
import { JodaPrintSignDto, ReportHardwareDto } from './hardware.dto';
import { JodaPrintService } from './jodaprint.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Hardware')
@ApiBearerAuth('JWT-auth')
@Controller('hardware')
export class HardwareController {
  constructor(
    private hardware: HardwareService,
    private jodaPrint: JodaPrintService,
  ) {}

  /** GET /hardware/capabilities — supported devices (scales, fiscal printers: not yet) */
  @Get('capabilities')
  @AnyMember()
  capabilities() {
    return this.hardware.capabilities();
  }

  /** PUT /hardware/status — this till (X-Device-Id) reports its bridge and printers */
  @Put('status')
  @RequireAnyPermission('pos.sell', 'hardware.manage')
  report(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ReportHardwareDto,
  ) {
    return this.hardware.report(
      tenantId,
      requestContext.get()?.deviceId,
      user.id,
      dto,
    );
  }

  /** GET /hardware/jodaprint — is the JodaPrint agent set up, and for which organization */
  @Get('jodaprint')
  @AnyMember()
  jodaPrintConfig() {
    return this.jodaPrint.publicConfig();
  }

  /**
   * POST /hardware/jodaprint/sign — sign one request of the POS page to the
   * JodaPrint agent on its computer (print, printer list, drawer...). Signed-in
   * store staff only; the drawer needs till or hardware rights.
   */
  @Post('jodaprint/sign')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @AnyMember()
  jodaPrintSign(@CurrentUser() user: AuthUser, @Body() dto: JodaPrintSignDto) {
    return this.jodaPrint.sign(dto, user.permissions);
  }

  /** GET /hardware/status — every till's last report */
  @Get('status')
  @RequirePermissions('hardware.manage')
  list(@CurrentTenant() tenantId: string) {
    return this.hardware.list(tenantId);
  }
}
