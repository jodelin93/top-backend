import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import {
  AnyMember,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { UnitsService } from './units.service';
import { CreateUnitDto, UpdateUnitDto } from './dto/units.dto';

/** Units of measure: GET /units, POST /units, PATCH/DELETE /units/:id */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Products')
@ApiBearerAuth('JWT-auth')
@Controller('units')
export class UnitsController {
  constructor(private unitsService: UnitsService) {}

  @Get()
  @AnyMember()
  list(@CurrentTenant() tenantId: string) {
    return this.unitsService.list(tenantId);
  }

  @Post()
  @RequirePermissions('catalog.manage')
  create(@CurrentTenant() tenantId: string, @Body() dto: CreateUnitDto) {
    return this.unitsService.create(tenantId, dto);
  }

  @Patch(':id')
  @RequirePermissions('catalog.manage')
  update(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUnitDto,
  ) {
    return this.unitsService.update(tenantId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('catalog.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.unitsService.remove(tenantId, id);
  }
}
