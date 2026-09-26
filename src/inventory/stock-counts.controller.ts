import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  APPROVAL_HEADER,
  PermissionsGuard,
} from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  AllowApproval,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { ApprovalsService } from '../approvals/approvals.service';
import { resolveDistinctApprover } from './separation-of-duties';
import { StockCountsService } from './stock-counts.service';
import { Idempotent } from '../common/idempotency/idempotent.decorator';
import {
  CreateStockCountDto,
  EnterCountsDto,
  InventoryReasonDto,
  StockCountsQueryDto,
} from './inventory.dto';

/**
 * Stock count sessions (R065)
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Inventory')
@ApiBearerAuth('JWT-auth')
@Controller('inventory/counts')
export class StockCountsController {
  constructor(
    private countsService: StockCountsService,
    private approvalsService: ApprovalsService,
  ) {}

  @Get()
  @RequirePermissions('inventory.count')
  list(@CurrentTenant() tenantId: string, @Query() query: StockCountsQueryDto) {
    return this.countsService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('inventory.count')
  get(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.countsService.get(tenantId, id);
  }

  @Post()
  @RequirePermissions('inventory.count')
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateStockCountDto,
  ) {
    return this.countsService.create(tenantId, user.id, dto);
  }

  // Save counted quantities (partial saves allowed)
  @Put(':id/items')
  @RequirePermissions('inventory.count')
  enterCounts(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EnterCountsDto,
  ) {
    return this.countsService.enterCounts(tenantId, id, dto);
  }

  // Posts at once when every variance is within the tolerance
  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('inventory.count')
  @Idempotent('stock_count.submit')
  submit(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.countsService.submit(tenantId, id, user.id);
  }

  /**
   * Approve and post variances above the tolerance; the approver must not be
   * the person who submitted the count
   */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('inventory.count.approve')
  @AllowApproval()
  @Idempotent('stock_count.approve')
  async approve(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(APPROVAL_HEADER) approvalToken?: string,
  ) {
    const count = await this.countsService.get(tenantId, id);
    const approverId = await resolveDistinctApprover({
      approvalsService: this.approvalsService,
      user,
      permission: 'inventory.count.approve',
      otherPartyId: count.submittedById,
      approvalToken,
      message:
        'You submitted this count: someone else must approve its variances',
    });
    return this.countsService.approve(tenantId, id, user.id, approverId);
  }

  // Back to counting
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('inventory.count.approve')
  @AllowApproval()
  reject(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InventoryReasonDto,
  ) {
    return this.countsService.reject(tenantId, id, dto.reason);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('inventory.count')
  cancel(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InventoryReasonDto,
  ) {
    return this.countsService.cancel(tenantId, id, dto.reason);
  }
}
