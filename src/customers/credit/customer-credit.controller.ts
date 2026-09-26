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
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { CurrentTenant } from '../../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import {
  AllowApproval,
  RequirePermissions,
} from '../../auth/decorators/permissions.decorator';
import type { AuthUser } from '../../auth/strategies/jwt.strategy';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { CustomerCreditService } from './customer-credit.service';
import {
  AdjustCustomerAccountDto,
  AgingQueryDto,
  CreditEntriesQueryDto,
  RecordCustomerPaymentDto,
  StatementQueryDto,
} from './customer-credit.dto';

/**
 * Customer accounts (D019): balance, ledger, statements, payments, adjustments.
 * The balance is never written directly: every change is a ledger entry.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Customer accounts')
@ApiBearerAuth('JWT-auth')
@Controller('customers/:id/account')
export class CustomerAccountController {
  constructor(private credit: CustomerCreditService) {}

  /** GET /customers/:id/account : balance, limit, available credit, terms, aging */
  @Get()
  @RequirePermissions('customers.finance.view')
  account(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.credit.account(tenantId, id);
  }

  /** GET /customers/:id/account/entries?from=&to=&page=&limit= */
  @Get('entries')
  @RequirePermissions('customers.finance.view')
  entries(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: CreditEntriesQueryDto,
  ) {
    return this.credit.entries(tenantId, id, query);
  }

  /** GET /customers/:id/account/statement?from=&to= (printable) */
  @Get('statement')
  @RequirePermissions('customers.finance.view')
  statement(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: StatementQueryDto,
  ) {
    return this.credit.statement(tenantId, id, query.from, query.to);
  }

  /**
   * Take a payment on the account (cash goes into the user's open shift on the
   * register). Balances come back only with customers.finance.view. Large
   * non-cash payments need a second person's approval (X-Approval-Token).
   * POST /customers/:id/account/payments
   */
  @Post('payments')
  @RequirePermissions('customers.credit.receive')
  @AllowApproval()
  @Idempotent('customers.account.payment')
  payment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordCustomerPaymentDto,
    @Headers('x-approval-token') approvalToken?: string,
  ) {
    return this.credit.recordPayment(tenantId, user, id, dto, approvalToken);
  }

  /**
   * Manual correction with a reason, or the opening balance
   * POST /customers/:id/account/adjustments
   */
  @Post('adjustments')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('customers.credit.manage')
  @AllowApproval()
  @Idempotent('customers.account.adjust')
  adjust(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustCustomerAccountDto,
  ) {
    return this.credit.adjust(tenantId, id, dto);
  }
}

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Customer accounts')
@ApiBearerAuth('JWT-auth')
@Controller('customer-accounts')
export class CustomerAccountsReportController {
  constructor(private credit: CustomerCreditService) {}

  /** GET /customer-accounts/aging?asOf=&nonZero=&search= */
  @Get('aging')
  @RequirePermissions('customers.finance.view')
  aging(@CurrentTenant() tenantId: string, @Query() query: AgingQueryDto) {
    return this.credit.agingReport(tenantId, query);
  }
}
