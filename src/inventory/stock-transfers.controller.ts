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
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  APPROVAL_HEADER,
  PermissionsGuard,
} from '../auth/guards/permissions.guard';
import { ApprovalsService } from '../approvals/approvals.service';
import {
  optionalApprover,
  resolveDistinctApprover,
} from './separation-of-duties';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  AllowApproval,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { StockTransfersService } from './stock-transfers.service';
import { Idempotent } from '../common/idempotency/idempotent.decorator';
import {
  InventoryReasonDto,
  SaveTransferDto,
  TransferDispatchDto,
  TransferQuantitiesDto,
  TransferReceiveDto,
  TransfersQueryDto,
} from './inventory.dto';
import { WRITE_OFF_REASON_MAX } from './transfer.logic';

export class TransferWriteOffDto extends TransferQuantitiesDto {
  // Why the units will never arrive (lost, stolen, damaged…): required
  @IsString()
  @IsNotEmpty()
  @MaxLength(WRITE_OFF_REASON_MAX)
  reason: string;
}

/**
 * Stock transfers between locations (R067)
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Inventory')
@ApiBearerAuth('JWT-auth')
@Controller('inventory/transfers')
export class StockTransfersController {
  constructor(
    private transfersService: StockTransfersService,
    private approvalsService: ApprovalsService,
  ) {}

  @Get()
  @RequirePermissions('inventory.view')
  list(@CurrentTenant() tenantId: string, @Query() query: TransfersQueryDto) {
    return this.transfersService.list(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('inventory.view')
  get(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.transfersService.get(tenantId, id);
  }

  @Post()
  @RequirePermissions('inventory.transfer')
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: SaveTransferDto,
  ) {
    return this.transfersService.create(tenantId, user.id, dto);
  }

  // Replace a draft
  @Put(':id')
  @RequirePermissions('inventory.transfer')
  update(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveTransferDto,
  ) {
    return this.transfersService.update(tenantId, id, dto);
  }

  /**
   * Submit a draft: approved at once, or waits for inventory.transfer.approve
   * when the store's transfer approval setting applies
   */
  @Post(':id/request')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('inventory.transfer')
  request(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.transfersService.request(tenantId, id, user.id);
  }

  // The approver must not be the requester
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('inventory.transfer.approve')
  @AllowApproval()
  async approve(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(APPROVAL_HEADER) approvalToken?: string,
  ) {
    const transfer = await this.transfersService.get(tenantId, id);
    const approverId = await resolveDistinctApprover({
      approvalsService: this.approvalsService,
      user,
      permission: 'inventory.transfer.approve',
      otherPartyId: transfer.requestedById,
      approvalToken,
      message: 'You requested this transfer: someone else must approve it',
    });
    return this.transfersService.approve(tenantId, id, approverId);
  }

  // Back to draft
  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('inventory.transfer.approve')
  @AllowApproval()
  reject(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InventoryReasonDto,
  ) {
    return this.transfersService.reject(tenantId, id, dto.reason);
  }

  /**
   * Send units (all remaining, or the given quantities); repeatable until
   * everything is sent or `complete`. Retries with the same idempotencyKey
   * post nothing twice.
   */
  @Post(':id/dispatch')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('inventory.transfer')
  @Idempotent('transfer.dispatch')
  dispatch(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferDispatchDto,
  ) {
    return this.transfersService.dispatch(tenantId, id, user.id, dto);
  }

  /**
   * Omit items to receive everything still in transit in good condition.
   * Lines can report damaged and missing units. Receiving more than was sent
   * above the store's tolerance needs inventory.transfer.approve (or a
   * manager's X-Approval-Token for it).
   */
  @Post(':id/receive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('inventory.transfer')
  @Idempotent('transfer.receive')
  async receive(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferReceiveDto,
    @Headers(APPROVAL_HEADER) approvalToken?: string,
  ) {
    const approverId = await optionalApprover({
      approvalsService: this.approvalsService,
      user,
      permission: 'inventory.transfer.approve',
      approvalToken,
    });
    return this.transfersService.receive(
      tenantId,
      id,
      user.id,
      dto,
      approverId,
    );
  }

  /**
   * Dispatched units that will never arrive; omit items for all outstanding.
   * A stock loss: needs inventory.adjust too (or a manager's X-Approval-Token
   * for it) and a reason; posts a loss movement in the ledger.
   */
  @Post(':id/write-off')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('inventory.transfer', 'inventory.adjust')
  @AllowApproval()
  writeOff(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferWriteOffDto,
  ) {
    return this.transfersService.writeOff(tenantId, id, user.id, dto);
  }

  // After dispatch, what is still in transit goes back to the source
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('inventory.transfer')
  cancel(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: InventoryReasonDto,
  ) {
    return this.transfersService.cancel(tenantId, id, user.id, dto.reason);
  }
}
