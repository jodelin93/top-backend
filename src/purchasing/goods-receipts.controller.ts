import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
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
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { PurchaseOrdersService } from './purchase-orders.service';
import { ReceiptsQueryDto, UnplannedReceiptDto } from './purchasing.dto';

/**
 * Goods receipts (GRN): against purchase orders (POST /purchase-orders/:id/receipts)
 * or unplanned, from a supplier without an order.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Purchasing')
@ApiBearerAuth('JWT-auth')
@Controller('goods-receipts')
export class GoodsReceiptsController {
  constructor(private purchaseOrdersService: PurchaseOrdersService) {}

  @Get()
  @RequireAnyPermission(
    'purchasing.manage',
    'purchasing.payables',
    'inventory.receive',
  )
  list(@CurrentTenant() tenantId: string, @Query() query: ReceiptsQueryDto) {
    return this.purchaseOrdersService.listReceipts(tenantId, query);
  }

  @Get(':id')
  @RequireAnyPermission(
    'purchasing.manage',
    'purchasing.payables',
    'inventory.receive',
  )
  get(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.purchaseOrdersService.getReceipt(tenantId, id);
  }

  /**
   * Receive goods from a supplier without a purchase order. Idempotent per
   * idempotencyKey (a retry returns the first receipt, duplicate: true).
   */
  @Post('unplanned')
  @RequirePermissions('inventory.receive', 'purchasing.receive.unplanned')
  receiveUnplanned(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UnplannedReceiptDto,
  ) {
    return this.purchaseOrdersService.receiveUnplanned(tenantId, user.id, dto);
  }
}
