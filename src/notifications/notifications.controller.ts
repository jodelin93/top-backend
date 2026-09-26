import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AnyMember } from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { branchScope } from '../auth/branch-scope';
import {
  NotificationReader,
  NotificationsService,
} from './notifications.service';
import {
  ListNotificationsQueryDto,
  UpdateNotificationPreferencesDto,
} from './notifications.dto';

const readerOf = (user: AuthUser): NotificationReader => ({
  id: user.id,
  tenantId: user.tenantId as string,
  permissions: user.permissions ?? [],
  branchIds: branchScope(user),
});

/**
 * The signed-in user's notifications (spec §15): what they are addressed to
 * directly or through one of their permissions, at their branches. Read state
 * is the user's own.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Notifications')
@ApiBearerAuth('JWT-auth')
@Controller('notifications')
export class NotificationsController {
  constructor(private notifications: NotificationsService) {}

  /** GET /notifications?unreadOnly=&type=&page=&limit= */
  @Get()
  @AnyMember()
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListNotificationsQueryDto,
  ) {
    return this.notifications.list(readerOf(user), query);
  }

  /** Unread count for the bell */
  @Get('unread-count')
  @AnyMember()
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(readerOf(user));
  }

  @Get('preferences')
  @AnyMember()
  async preferences(@CurrentUser() user: AuthUser) {
    return {
      ...(await this.notifications.getPreferences(
        user.tenantId as string,
        user.id,
      )),
      emailAvailable: this.notifications.emailAvailable,
      types: this.notifications
        .types()
        .filter((t) => user.permissions?.some((p) => p === t.permission)),
    };
  }

  @Put('preferences')
  @AnyMember()
  updatePreferences(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateNotificationPreferencesDto,
  ) {
    return this.notifications.updatePreferences(
      user.tenantId as string,
      user.id,
      dto,
    );
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @AnyMember()
  markAllRead(@CurrentUser() user: AuthUser) {
    return this.notifications.markAllRead(readerOf(user));
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @AnyMember()
  markRead(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notifications.markRead(readerOf(user), id);
  }
}
