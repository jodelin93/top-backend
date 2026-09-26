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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import {
  AnyMember,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { ExchangesService } from './exchanges.service';
import {
  CancelExchangeDto,
  CompleteExchangeDto,
  CreateExchangeDto,
  ListExchangesQueryDto,
} from './returns.dto';

/**
 * Exchanges: a return and its replacement sale in one request.
 * Registered before ReturnsController so /returns/exchanges isn't taken for an id.
 */
@ApiTags('Sales')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('returns/exchanges')
export class ExchangesController {
  constructor(private exchanges: ExchangesService) {}

  /** GET /returns/exchanges?status=incomplete */
  @Get()
  @RequirePermissions('sales.view')
  findAll(
    @CurrentTenant() tenantId: string,
    @Query() query: ListExchangesQueryDto,
  ) {
    return this.exchanges.findAll(tenantId, query);
  }

  @Get(':id')
  @RequirePermissions('sales.view')
  findOne(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.exchanges.findOne(tenantId, id);
  }

  /**
   * Return goods and ring up their replacement. Needs sales.refund and pos.sell
   * (enforced by the services, with manager approvals where they allow them).
   * POST /returns/exchanges
   */
  @Post()
  @AnyMember()
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateExchangeDto,
    @Headers('x-approval-token') approvalToken?: string,
  ) {
    return this.exchanges.create(tenantId, user, dto, approvalToken);
  }

  /** POST /returns/exchanges/:id/complete : ring up the replacement of an incomplete exchange */
  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('pos.sell')
  complete(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteExchangeDto,
    @Headers('x-approval-token') approvalToken?: string,
  ) {
    return this.exchanges.complete(tenantId, user, id, dto, approvalToken);
  }

  /**
   * POST /returns/exchanges/:id/cancel : give up an incomplete exchange and
   * refund its credit (sales.refund; another tender than the sale's needs
   * sales.refund.any_method or a manager's approval, checked by the service)
   */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @AnyMember()
  cancel(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelExchangeDto,
    @Headers('x-approval-token') approvalToken?: string,
  ) {
    return this.exchanges.cancel(tenantId, user, id, dto, approvalToken);
  }
}
