import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { DrawersService } from './drawers.service';
import {
  CreateDrawerDto,
  ListDrawersQueryDto,
  UpdateDrawerDto,
} from './shifts.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Shifts')
@ApiBearerAuth('JWT-auth')
@Controller('drawers')
export class DrawersController {
  constructor(private drawersService: DrawersService) {}

  /** GET /drawers?registerId= — with the shift running on each */
  @Get()
  @RequireAnyPermission('shifts.operate', 'shifts.manage', 'settings.manage')
  list(@CurrentTenant() tenantId: string, @Query() query: ListDrawersQueryDto) {
    return this.drawersService.list(tenantId, query);
  }

  @Post()
  @RequirePermissions('settings.manage')
  create(@CurrentTenant() tenantId: string, @Body() dto: CreateDrawerDto) {
    return this.drawersService.create(tenantId, dto);
  }

  @Patch(':id')
  @RequirePermissions('settings.manage')
  update(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDrawerDto,
  ) {
    return this.drawersService.update(tenantId, id, dto);
  }
}
