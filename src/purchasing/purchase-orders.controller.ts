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
import { resolveDistinctApprover } from '../inventory/separation-of-duties';
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  ClosePurchaseOrderDto,
  PurchaseOrdersQueryDto,
  ReasonDto,
  ReceivePurchaseOrderDto,
  RevisePurchaseOrderDto,
  SavePurchaseOrderDto,
} from './purchasing.dto';

/**
 * Purchase orders (R071–R073, spec §10)
 * draft → (submit) pending_approval | approved → (approve) approved →
 * (issue) issued → (receive) partially_received → received → (close) closed;
 * cancel before any receipt; short-close (close) a partly received order;
 * revise an approved / issued / partly received order (back to approval above
 * the threshold).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Purchasing')
@ApiBearerAuth('JWT-auth')
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(
    private purchaseOrdersService: PurchaseOrdersService,
    private approvalsService: ApprovalsService,
  ) {}

  @Get()
  @RequirePermissions('purchasing.manage')
  list(
    @CurrentTenant() tenantId: string,
    @Query() query: PurchaseOrdersQueryDto,
  ) {
    return this.purchaseOrdersService.list(tenantId, query);
  }

  // Receivers need to see the order they are receiving
  @Get(':id')
  @RequirePermissions('inventory.receive')
  get(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.purchaseOrdersService.get(tenantId, id);
  }

  @Post()
  @RequirePermissions('purchasing.manage')
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: SavePurchaseOrderDto,
  ) {
    return this.purchaseOrdersService.create(tenantId, user.id, dto);
  }

  // Replace a draft
  @Put(':id')
  @RequirePermissions('purchasing.manage')
  update(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SavePurchaseOrderDto,
  ) {
    return this.purchaseOrdersService.update(tenantId, id, dto);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchasing.manage')
  submit(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.purchaseOrdersService.submit(tenantId, id);
  }

  /**
   * Needs purchasing.approve, from someone other than the creator
   * (manager override via X-Approval-Token)
   */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchasing.approve')
  @AllowApproval()
  async approve(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(APPROVAL_HEADER) approvalToken?: string,
  ) {
    const po = await this.purchaseOrdersService.get(tenantId, id);
    const approverId = await resolveDistinctApprover({
      approvalsService: this.approvalsService,
      user,
      permission: 'purchasing.approve',
      otherPartyId: PurchaseOrdersService.requesterOf(po),
      approvalToken,
      message: po.revisedById
        ? 'You revised this purchase order: someone else with purchasing approval must approve it'
        : 'You created this purchase order: someone else with purchasing approval must approve it',
    });
    return this.purchaseOrdersService.approve(tenantId, id, approverId);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchasing.approve')
  @AllowApproval()
  reject(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.purchaseOrdersService.reject(tenantId, id, dto.reason);
  }

  /**
   * Change an approved, issued or partly received order. Recorded as a
   * revision; above the approval threshold it goes back for approval.
   */
  @Post(':id/revise')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchasing.manage')
  revise(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevisePurchaseOrderDto,
  ) {
    return this.purchaseOrdersService.revise(tenantId, user.id, id, dto);
  }

  /**
   * Close the order; on a partly received order this short-closes it (the
   * unreceived remainder is cancelled, received goods stay). Reason required.
   */
  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchasing.manage')
  close(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClosePurchaseOrderDto,
  ) {
    return this.purchaseOrdersService.close(tenantId, id, dto.reason);
  }

  @Post(':id/issue')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchasing.manage')
  issue(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.purchaseOrdersService.issue(tenantId, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchasing.manage')
  cancel(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    return this.purchaseOrdersService.cancel(tenantId, id, dto.reason);
  }

  /**
   * Goods receipt against the order. Retrying with the same idempotencyKey
   * returns the original receipt (duplicate: true) without posting stock again.
   * Receiving beyond the over-receipt tolerance needs purchasing.approve, or a
   * manager's approval token (X-Approval-Token), checked by the service.
   */
  @Post(':id/receipts')
  @RequirePermissions('inventory.receive')
  receive(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReceivePurchaseOrderDto,
    @Headers(APPROVAL_HEADER) approvalToken?: string,
  ) {
    return this.purchaseOrdersService.receive(tenantId, user.id, id, dto, {
      user,
      approvalToken,
    });
  }
}
