import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  AllowApproval,
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { User } from '../database/entities/user.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { APPROVAL_HEADER } from '../auth/guards/permissions.guard';
import { Idempotent } from '../common/idempotency/idempotent.decorator';
import { SalesService } from './sales.service';
import { PosService } from './pos.service';
import {
  CancelSaleDto,
  CatalogQueryDto,
  CreateSaleDto,
  HeldSalesQueryDto,
  HoldSaleDto,
  ListSalesQueryDto,
  QuoteSaleDto,
  VoidSaleDto,
} from './sales.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Sales')
@ApiBearerAuth('JWT-auth')
@Controller('sales')
export class SalesController {
  constructor(private salesService: SalesService) {}

  /**
   * GET /sales?from=&to=&status=&customerId=&registerId=&search=&page=&limit=
   */
  @Get()
  @RequirePermissions('sales.view')
  findAll(
    @CurrentTenant() tenantId: string,
    @Query() query: ListSalesQueryDto,
  ) {
    return this.salesService.findAll(tenantId, query);
  }

  /**
   * Price a cart without saving it
   * POST /sales/quote
   */
  @Post('quote')
  @RequirePermissions('pos.sell')
  quote(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: QuoteSaleDto,
    @Headers(APPROVAL_HEADER) approvalToken?: string,
  ) {
    return this.salesService.quote(tenantId, user, dto, approvalToken);
  }

  /**
   * Complete a sale (or start card payments: status payment_pending)
   * POST /sales — X-Approval-Token for discounts/price changes above the user's rights
   */
  @Post()
  @RequirePermissions('pos.sell')
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSaleDto,
    @Headers(APPROVAL_HEADER) approvalToken?: string,
  ) {
    return this.salesService.create(tenantId, user, dto, approvalToken);
  }

  /**
   * Park the cart (stock reserved until it expires)
   * POST /sales/hold
   */
  @Post('hold')
  @RequirePermissions('pos.hold')
  hold(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: HoldSaleDto,
  ) {
    return this.salesService.hold(tenantId, user, dto);
  }

  /**
   * GET /sales/held?registerId=&branchId=
   */
  @Get('held')
  @RequirePermissions('pos.hold')
  listHeld(
    @CurrentTenant() tenantId: string,
    @Query() query: HeldSalesQueryDto,
  ) {
    return this.salesService.listHeld(tenantId, query);
  }

  /**
   * Load a held cart back into a till: { sale, cart }
   * POST /sales/:id/resume
   */
  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('pos.hold')
  resume(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.salesService.resume(tenantId, id);
  }

  /**
   * Cancel a held cart or a sale waiting for its card payment
   * POST /sales/:id/cancel
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('pos.sell')
  cancel(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelSaleDto,
  ) {
    return this.salesService.cancel(tenantId, id, dto.reason);
  }

  /**
   * Count a receipt reprint (printed as "COPY")
   * POST /sales/:id/reprint
   */
  @Post(':id/reprint')
  @HttpCode(HttpStatus.OK)
  // Separate from viewing sales (spec §15); the POS records reprints through
  // POST /print-jobs (copy: true), which counts them the same way
  @RequirePermissions('sales.reprint')
  reprint(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.salesService.reprint(tenantId, id);
  }

  /**
   * Sale details / receipt
   * GET /sales/:id
   */
  @Get(':id')
  @RequirePermissions('sales.view')
  findOne(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.salesService.findOne(tenantId, id);
  }

  /**
   * Void a sale (restocks items)
   * POST /sales/:id/void
   */
  @Post(':id/void')
  @RequirePermissions('sales.void')
  @AllowApproval()
  @Idempotent('sales.void')
  void(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidSaleDto,
  ) {
    return this.salesService.void(tenantId, user, id, dto.reason);
  }
}

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('POS')
@ApiBearerAuth('JWT-auth')
@Controller('pos')
export class PosController {
  constructor(private posService: PosService) {}

  /**
   * Settings, registers, payment methods, categories and tax rate for the POS
   * GET /pos/context
   */
  @Get('context')
  @RequirePermissions('pos.sell')
  context(@CurrentTenant() tenantId: string) {
    return this.posService.getContext(tenantId);
  }

  /**
   * Sellable items with price and stock
   * GET /pos/catalog?registerId=&search=&barcode=&categoryId=
   */
  @Get('catalog')
  // The estimate screen searches the catalog too
  @RequireAnyPermission('pos.sell', 'estimates.manage')
  catalog(@CurrentTenant() tenantId: string, @Query() query: CatalogQueryDto) {
    return this.posService.getCatalog(tenantId, query);
  }

  /**
   * Staff the cashier can credit a sale to (salesperson): id and name only
   * GET /pos/staff
   */
  @Get('staff')
  @RequirePermissions('pos.sell')
  staff(@CurrentTenant() tenantId: string) {
    return this.posService.getStaff(tenantId);
  }
}
