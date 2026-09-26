import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  AllowApproval,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { AuditService } from '../audit/audit.service';
import { requestContext } from '../common/context/request-context';
import { SyncService } from './sync.service';
import { SyncPushService } from './sync-push.service';
import {
  SyncChangesQueryDto,
  SyncExportApprovalDto,
  SyncImportDto,
  SyncPushDto,
} from './sync.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Sync')
@ApiBearerAuth('JWT-auth')
@Controller('sync')
export class SyncController {
  constructor(
    private readonly syncService: SyncService,
    private readonly pushService: SyncPushService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Changes since an opaque cursor (catalog and stock at the register, customers,
   * POS context), tombstones included. Without a cursor: reset=true plus a
   * cursor to continue from after a full download.
   */
  @Get('changes')
  @RequirePermissions('pos.sell')
  changes(
    @CurrentTenant() tenantId: string,
    @Query() query: SyncChangesQueryDto,
  ) {
    return this.syncService.changes(tenantId, query);
  }

  /**
   * Batched upload of operations recorded on the till, applied in device
   * sequence order, each acknowledged (accepted / already_applied /
   * pending_dependency / needs_review).
   */
  @Post('push')
  @RequirePermissions('pos.sell')
  @HttpCode(HttpStatus.OK)
  push(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: SyncPushDto,
  ) {
    return this.pushService.push(tenantId, user, dto);
  }

  /** Upload the export file of a dead till (same processing as a push). */
  @Post('import')
  @RequirePermissions('devices.manage')
  @HttpCode(HttpStatus.OK)
  import(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: SyncImportDto,
  ) {
    return this.pushService.push(tenantId, user, dto, { importedBy: user.id });
  }

  /**
   * A manager allows exporting this till's unsynced sales to a file (the file
   * holds payment and customer data). Cashiers get it with a manager's approval.
   */
  @Post('export-approval')
  @RequirePermissions('sales.review')
  @AllowApproval()
  @HttpCode(HttpStatus.OK)
  async exportApproval(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() body: SyncExportApprovalDto,
  ) {
    const approverId = requestContext.get()?.approverId ?? user.id;
    await this.auditService.record({
      tenantId,
      action: 'sync.exported',
      entityType: 'device',
      entityId: body?.deviceId ?? null,
      metadata: {
        operations: body?.operations ?? null,
        requestedBy: user.id,
        approvedBy: approverId,
      },
    });
    return { approved: true, approvedBy: approverId, at: new Date() };
  }
}
