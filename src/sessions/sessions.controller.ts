import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import {
  AnyMember,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { AllowDuringMfaSetup } from '../auth/decorators/mfa-setup.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { SessionsService } from './sessions.service';
import { UsersService } from '../users/users.service';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Sessions')
@ApiBearerAuth('JWT-auth')
@Controller('sessions')
export class SessionsController {
  constructor(
    private readonly sessionsService: SessionsService,
    private readonly usersService: UsersService,
  ) {}

  /** My signed-in sessions (the current one is flagged). */
  @Get()
  @AnyMember()
  @AllowDuringMfaSetup()
  list(@CurrentUser() user: AuthUser) {
    return this.sessionsService.listForUser(user.id, user.sessionId ?? null);
  }

  /** Sign out every other session (keeps this one). */
  @Post('revoke-others')
  @AnyMember()
  @AllowDuringMfaSetup()
  @HttpCode(HttpStatus.OK)
  async revokeOthers(@CurrentUser() user: AuthUser) {
    return {
      revoked: await this.sessionsService.revokeOthers(
        user.id,
        user.sessionId ?? null,
        user.tenantId,
      ),
    };
  }

  /** Sign out one of my sessions. */
  @Delete(':id')
  @AnyMember()
  @AllowDuringMfaSetup()
  @HttpCode(HttpStatus.OK)
  async revoke(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.sessionsService.revokeOwn(
      user.id,
      id,
      id === user.sessionId ? 'logout' : 'revoked_by_user',
      user.tenantId,
    );
    return { success: true };
  }

  /** Admin: a member's active sessions in this store. */
  @Get('members/:userId')
  @RequirePermissions('users.manage')
  async listForMember(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.usersService.assertCanManageAccount(tenantId, user, userId);
    return this.sessionsService.listForMember(tenantId, userId);
  }

  /** Admin: sign a member out of every session in this store. */
  @Post('members/:userId/revoke')
  @RequirePermissions('users.manage')
  @HttpCode(HttpStatus.OK)
  async revokeMember(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    await this.usersService.assertCanManageAccount(tenantId, user, userId);
    return {
      revoked: await this.sessionsService.revokeMember(tenantId, userId),
    };
  }
}
