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
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
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
import { OrdersService } from './orders.service';
import {
  AddDepositDto,
  CancelOrderDto,
  CreateOrderDto,
  ListOrdersQueryDto,
  QuoteOrderDto,
  SetOrderStatusDto,
  UpdateOrderDto,
} from './orders.dto';

/**
 * Orders with a deposit (services prepared for a customer who pays the rest at
 * pickup). The pickup itself is a sale: POST /sales with orderId.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Orders')
@ApiBearerAuth('JWT-auth')
@Controller('orders')
export class OrdersController {
  constructor(private orders: OrdersService) {}

  /** GET /orders?status=active|open|ready|picked_up|cancelled&search=&branchId=&customerId= */
  @Get()
  @RequirePermissions('orders.manage')
  findAll(
    @CurrentTenant() tenantId: string,
    @Query() query: ListOrdersQueryDto,
  ) {
    return this.orders.findAll(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('orders.manage')
  findOne(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.orders.findOne(tenantId, id);
  }

  /**
   * Price an order's cart (approvals for discounts / prices are asked here and
   * used by POST /orders). POST /orders/quote
   */
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.manage')
  quote(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: QuoteOrderDto,
    @Headers(APPROVAL_HEADER) approvalToken?: string,
  ) {
    return this.orders.quote(tenantId, user, dto, approvalToken);
  }

  /** Take an order, with its deposit (cash into the till's open session). POST /orders */
  @Post()
  @RequirePermissions('orders.manage')
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateOrderDto,
    @Headers(APPROVAL_HEADER) approvalToken?: string,
  ) {
    return this.orders.create(tenantId, user, dto, approvalToken);
  }

  /** Another deposit. POST /orders/:id/deposits */
  @Post(':id/deposits')
  @RequirePermissions('orders.manage')
  addDeposit(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddDepositDto,
  ) {
    return this.orders.addDeposit(tenantId, user, id, dto);
  }

  /** Ready for pickup, or back in preparation. POST /orders/:id/status */
  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.manage')
  setStatus(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetOrderStatusDto,
  ) {
    return this.orders.setStatus(tenantId, user, id, dto);
  }

  /** Ready date and notes. PATCH /orders/:id */
  @Patch(':id')
  @RequirePermissions('orders.manage')
  update(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderDto,
  ) {
    return this.orders.update(tenantId, id, dto);
  }

  /**
   * Cancel: the deposits are refunded or kept, with a reason. Needs
   * orders.cancel, or a manager's approval (X-Approval-Token).
   * POST /orders/:id/cancel
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('orders.cancel')
  @AllowApproval()
  cancel(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.orders.cancel(tenantId, user, id, dto);
  }
}
