import {
  Body,
  Controller,
  Get,
  Headers,
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
  AllowApproval,
  AnyMember,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { ReturnsService } from './returns.service';
import {
  CreateReturnDto,
  ListReturnsQueryDto,
  SaleLookupQueryDto,
} from './returns.dto';

@ApiTags('Sales')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('returns')
export class ReturnsController {
  constructor(private returnsService: ReturnsService) {}

  /**
   * GET /returns?from=&to=&status=&saleId=&search=&page=&limit=
   */
  @Get()
  @RequirePermissions('sales.view')
  findAll(
    @CurrentTenant() tenantId: string,
    @Query() query: ListReturnsQueryDto,
  ) {
    return this.returnsService.findAll(tenantId, query);
  }

  /**
   * A sale by receipt number, with what can still be returned
   * GET /returns/lookup?saleNumber=S-000123
   */
  @Get('lookup')
  @RequirePermissions('sales.refund')
  @AllowApproval()
  lookup(
    @CurrentTenant() tenantId: string,
    @Query() query: SaleLookupQueryDto,
  ) {
    return this.returnsService.lookupSale(tenantId, query.saleNumber);
  }

  @Get(':id')
  @RequirePermissions('sales.view')
  findOne(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.returnsService.findOne(tenantId, id);
  }

  /**
   * Return items and refund the customer.
   * Needs sales.refund; a return outside the return window, or a refund to another
   * payment method than the sale was paid with (sales.refund.any_method), needs a
   * manager's approval (X-Approval-Token, comma-separated when several are needed).
   * All of these are checked by ReturnsService.create, not PermissionsGuard: the guard
   * verifies a single token, and a user without sales.refund may need two approvals.
   * POST /returns
   */
  @Post()
  @AnyMember() // ReturnsService.create enforces sales.refund (or its approvals)
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateReturnDto,
    @Headers('x-approval-token') approvalToken?: string,
  ) {
    return this.returnsService.create(tenantId, user, dto, approvalToken);
  }

  /**
   * Send failed or pending card refunds to the provider again
   * POST /returns/:id/retry-refunds
   */
  @Post(':id/retry-refunds')
  @RequirePermissions('sales.refund')
  retryRefunds(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.returnsService.retryRefunds(tenantId, id);
  }
}
