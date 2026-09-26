import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { DevicesService } from './devices.service';
import {
  DeviceSummaryQueryDto,
  HeartbeatDto,
  LeaseRequestDto,
  RegisterDeviceDto,
  RevokeDeviceDto,
  UpdateDeviceDto,
} from './devices.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Devices')
@ApiBearerAuth('JWT-auth')
@Controller('devices')
export class DevicesController {
  constructor(private readonly devicesService: DevicesService) {}

  // ---- Called by the POS ----

  /** Register this till (or refresh an existing registration) */
  @Post('register')
  @RequirePermissions('pos.sell')
  register(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: RegisterDeviceDto,
  ) {
    return this.devicesService.register(tenantId, user.id, dto);
  }

  /** Heartbeat with the offline queue size */
  @Post(':id/heartbeat')
  @RequirePermissions('pos.sell')
  @HttpCode(HttpStatus.OK)
  heartbeat(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: HeartbeatDto,
  ) {
    return this.devicesService.heartbeat(tenantId, user, id, dto);
  }

  /** Obtain / renew the signed offline lease */
  @Post(':id/lease')
  @RequirePermissions('pos.sell')
  @HttpCode(HttpStatus.OK)
  lease(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LeaseRequestDto,
  ) {
    return this.devicesService.renewLease(tenantId, user, id, dto?.registerId);
  }

  // ---- Back office ----

  /** Data freshness for the dashboard (unsynced sales, silent tills, gaps) */
  @Get('summary')
  @RequirePermissions('reports.view')
  summary(
    @CurrentTenant() tenantId: string,
    @Query() query: DeviceSummaryQueryDto,
  ) {
    return this.devicesService.summary(tenantId, query.staleMinutes);
  }

  @Get()
  @RequirePermissions('devices.manage')
  list(
    @CurrentTenant() tenantId: string,
    @Query() query: DeviceSummaryQueryDto,
  ) {
    return this.devicesService.list(tenantId, query.staleMinutes);
  }

  @Get(':id')
  @RequirePermissions('devices.manage')
  detail(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.devicesService.detail(tenantId, id);
  }

  @Patch(':id')
  @RequirePermissions('devices.manage')
  update(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeviceDto,
  ) {
    return this.devicesService.update(tenantId, id, dto);
  }

  @Post(':id/revoke')
  @RequirePermissions('devices.manage')
  @HttpCode(HttpStatus.OK)
  revoke(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeDeviceDto,
  ) {
    return this.devicesService.revoke(tenantId, user.id, id, dto.reason);
  }

  /** Lost / abandoned till: revoke for good, open a review case, refuse its sync */
  @Post(':id/mark-lost')
  @RequirePermissions('devices.manage')
  @HttpCode(HttpStatus.OK)
  markLost(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeDeviceDto,
  ) {
    return this.devicesService.markLost(tenantId, user.id, id, dto.reason);
  }

  @Post(':id/restore')
  @RequirePermissions('devices.manage')
  @HttpCode(HttpStatus.OK)
  restore(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.devicesService.restore(tenantId, id);
  }
}
