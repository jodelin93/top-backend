import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { UsersService } from './users.service';
import {
  CreateMemberDto,
  ResetPasswordDto,
  UpdateMemberDto,
} from './users.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('users.manage')
@ApiTags('Users')
@ApiBearerAuth('JWT-auth')
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Get()
  findAll(@CurrentTenant() tenantId: string) {
    return this.usersService.findAll(tenantId);
  }

  @Post()
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: CreateMemberDto,
  ) {
    return this.usersService.create(tenantId, actor, dto);
  }

  @Patch(':userId')
  update(
    @CurrentTenant() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateMemberDto,
  ) {
    return this.usersService.update(tenantId, actor, userId, dto);
  }

  @Post(':userId/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  resetPassword(
    @CurrentTenant() tenantId: string,
    @CurrentUser() actor: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return this.usersService.resetPassword(
      tenantId,
      actor,
      userId,
      dto.password,
    );
  }
}
