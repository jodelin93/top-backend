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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import {
  AnyMember,
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { RolesService } from './roles.service';
import { CreateRoleDto, UpdateRoleDto } from './roles.dto';

@ApiTags('Users')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('roles')
export class RolesController {
  constructor(private rolesService: RolesService) {}

  /**
   * Every permission a role can grant, grouped for display
   * GET /roles/permissions
   */
  @Get('permissions')
  @AnyMember() // labels, e.g. for the approval dialog
  permissions() {
    return this.rolesService.permissionCatalog();
  }

  @Get()
  @RequireAnyPermission('roles.manage', 'users.manage')
  findAll(@CurrentTenant() tenantId: string) {
    return this.rolesService.findAll(tenantId);
  }

  @Post()
  @RequirePermissions('roles.manage')
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: CreateRoleDto,
  ) {
    return this.rolesService.create(tenantId, dto, actor);
  }

  @Patch(':id')
  @RequirePermissions('roles.manage')
  update(
    @CurrentTenant() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.rolesService.update(tenantId, id, dto, actor);
  }

  @Delete(':id')
  @RequirePermissions('roles.manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentTenant() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.rolesService.remove(tenantId, id, actor);
  }
}
