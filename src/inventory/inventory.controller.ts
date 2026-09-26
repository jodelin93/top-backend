import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  AllowApproval,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { User } from '../database/entities/user.entity';
import { InventoryService } from './inventory.service';
import { StockProjectionService } from './stock-projection.service';
import {
  AgingQueryDto,
  ChangeCostingMethodDto,
  CreateAdjustmentDto,
  MovementsQueryDto,
  RevalueCostDto,
  RebuildStockDto,
  ReceiveStockDto,
  ReservationsQueryDto,
  StockQueryDto,
} from './inventory.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Inventory')
@ApiBearerAuth('JWT-auth')
@Controller('inventory')
export class InventoryController {
  constructor(
    private inventoryService: InventoryService,
    private projectionService: StockProjectionService,
  ) {}

  /**
   * Stock on hand per variant and location
   * GET /inventory/stock?search=&locationId=&lowStock=true
   */
  @Get('stock')
  @RequirePermissions('inventory.view')
  listStock(@CurrentTenant() tenantId: string, @Query() query: StockQueryDto) {
    return this.inventoryService.listStock(tenantId, query);
  }

  /**
   * Stock movement history
   * GET /inventory/movements?variantId=&locationId=&limit=
   */
  @Get('movements')
  @RequirePermissions('inventory.view')
  listMovements(
    @CurrentTenant() tenantId: string,
    @Query() query: MovementsQueryDto,
  ) {
    return this.inventoryService.listMovements(tenantId, query);
  }

  /**
   * Record a stock count or correction
   * POST /inventory/adjustments
   */
  @Post('adjustments')
  @RequirePermissions('inventory.adjust')
  createAdjustment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: User,
    @Body() dto: CreateAdjustmentDto,
  ) {
    return this.inventoryService.createAdjustment(tenantId, user.id, dto);
  }

  /**
   * Receive delivered stock
   * POST /inventory/receive
   */
  @Post('receive')
  @RequirePermissions('inventory.receive')
  receiveStock(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: User,
    @Body() dto: ReceiveStockDto,
  ) {
    return this.inventoryService.receiveStock(tenantId, user.id, dto);
  }

  /**
   * Stock aging: days since last receipt per variant and location
   * GET /inventory/aging?locationId=&search=&minDays=
   */
  @Get('aging')
  @RequirePermissions('inventory.view')
  aging(@CurrentTenant() tenantId: string, @Query() query: AgingQueryDto) {
    return this.inventoryService.aging(tenantId, query);
  }

  /**
   * Manual cost revaluation: new unit cost + a zero-quantity valuation entry (audited)
   * POST /inventory/revaluations
   */
  @Post('revaluations')
  @RequirePermissions('inventory.adjust', 'inventory.cost.view')
  @AllowApproval()
  revalue(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: User,
    @Body() dto: RevalueCostDto,
  ) {
    return this.inventoryService.revalue(tenantId, user.id, dto);
  }

  /**
   * Switch average ↔ FIFO for a store holding stock, revaluing every variant
   * POST /inventory/costing-method
   */
  @Post('costing-method')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('settings.manage', 'inventory.cost.view')
  changeCostingMethod(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: User,
    @Body() dto: ChangeCostingMethodDto,
  ) {
    return this.inventoryService.changeCostingMethod(tenantId, user.id, dto);
  }

  /**
   * Stock held for held carts / orders
   * GET /inventory/reservations?status=active&variantId=&locationId=
   */
  @Get('reservations')
  @RequirePermissions('inventory.view')
  listReservations(
    @CurrentTenant() tenantId: string,
    @Query() query: ReservationsQueryDto,
  ) {
    return this.inventoryService.listReservations(tenantId, query);
  }

  /**
   * Dry run: differences between the stock projections and the movement ledger
   * GET /inventory/rebuild?locationId=
   */
  @Get('rebuild')
  @RequirePermissions('inventory.adjust')
  previewRebuild(
    @CurrentTenant() tenantId: string,
    @Query() query: RebuildStockDto,
  ) {
    return this.projectionService.preview(tenantId, query.locationId);
  }

  /**
   * Recompute on-hand quantities from the ledger (audited)
   * POST /inventory/rebuild
   */
  @Post('rebuild')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('inventory.adjust')
  @AllowApproval()
  applyRebuild(
    @CurrentTenant() tenantId: string,
    @Body() dto: RebuildStockDto,
  ) {
    return this.projectionService.apply(tenantId, dto.locationId);
  }
}
