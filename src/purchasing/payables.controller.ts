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
import {
  APPROVAL_HEADER,
  PermissionsGuard,
} from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  AllowApproval,
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { ApprovalsService } from '../approvals/approvals.service';
import { resolveDistinctApprover } from '../inventory/separation-of-duties';
import { SupplierInvoicesService } from './supplier-invoices.service';
import { PayablesService } from './payables.service';
import {
  AgingQueryDto,
  AllocateDto,
  CreateSupplierCreditDto,
  CreateSupplierInvoiceDto,
  CreateSupplierPaymentDto,
  StatementQueryDto,
  SupplierDocumentsQueryDto,
  VoidDto,
} from './purchasing.dto';

/**
 * Supplier invoices (3-way match), credits, payments and allocations; balances,
 * aging and statements are derived from them (spec §10).
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Purchasing')
@ApiBearerAuth('JWT-auth')
@Controller()
export class PayablesController {
  constructor(
    private invoicesService: SupplierInvoicesService,
    private payablesService: PayablesService,
    private approvalsService: ApprovalsService,
  ) {}

  // ---- Invoices ----

  @Get('supplier-invoices')
  @RequireAnyPermission('purchasing.payables', 'purchasing.approve')
  listInvoices(
    @CurrentTenant() tenantId: string,
    @Query() query: SupplierDocumentsQueryDto,
  ) {
    return this.invoicesService.list(tenantId, query);
  }

  @Get('supplier-invoices/:id')
  @RequireAnyPermission('purchasing.payables', 'purchasing.approve')
  getInvoice(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.invoicesService.get(tenantId, id);
  }

  /**
   * Enter a supplier invoice. Lines matched to order lines are checked against
   * the order price and the received quantity; outside the tolerance the
   * invoice waits for approval. 409 when the number was already entered.
   */
  @Post('supplier-invoices')
  @RequirePermissions('purchasing.payables')
  createInvoice(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSupplierInvoiceDto,
  ) {
    return this.invoicesService.create(tenantId, user.id, dto);
  }

  // Someone other than who entered it (manager override via X-Approval-Token)
  @Post('supplier-invoices/:id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchasing.approve')
  @AllowApproval()
  async approveInvoice(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(APPROVAL_HEADER) approvalToken?: string,
  ) {
    const invoice = await this.invoicesService.get(tenantId, id);
    const approverId = await resolveDistinctApprover({
      approvalsService: this.approvalsService,
      user,
      permission: 'purchasing.approve',
      otherPartyId: invoice.userId,
      approvalToken,
      message:
        'You entered this invoice: someone else with purchasing approval must approve it',
    });
    return this.invoicesService.approve(tenantId, id, approverId);
  }

  @Post('supplier-invoices/:id/void')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchasing.payables')
  voidInvoice(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidDto,
  ) {
    return this.invoicesService.void(tenantId, id, dto.reason);
  }

  // ---- Credits ----

  @Get('supplier-credits')
  @RequireAnyPermission('purchasing.payables', 'purchasing.approve')
  listCredits(
    @CurrentTenant() tenantId: string,
    @Query() query: SupplierDocumentsQueryDto,
  ) {
    return this.payablesService.listCredits(tenantId, query);
  }

  @Get('supplier-credits/:id')
  @RequireAnyPermission('purchasing.payables', 'purchasing.approve')
  getCredit(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.payablesService.getCredit(tenantId, id);
  }

  @Post('supplier-credits')
  @RequirePermissions('purchasing.payables')
  createCredit(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSupplierCreditDto,
  ) {
    return this.payablesService.createCredit(tenantId, user.id, dto);
  }

  @Post('supplier-credits/:id/allocations')
  @RequirePermissions('purchasing.payables')
  allocateCredit(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AllocateDto,
  ) {
    return this.payablesService.allocateCredit(tenantId, user.id, id, dto);
  }

  @Post('supplier-credits/:id/void')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchasing.payables')
  voidCredit(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidDto,
  ) {
    return this.payablesService.voidCredit(tenantId, id, dto.reason);
  }

  // ---- Payments ----

  @Get('supplier-payments')
  @RequireAnyPermission('purchasing.payables', 'purchasing.approve')
  listPayments(
    @CurrentTenant() tenantId: string,
    @Query() query: SupplierDocumentsQueryDto,
  ) {
    return this.payablesService.listPayments(tenantId, query);
  }

  @Get('supplier-payments/:id')
  @RequireAnyPermission('purchasing.payables', 'purchasing.approve')
  getPayment(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.payablesService.getPayment(tenantId, id);
  }

  @Post('supplier-payments')
  @RequirePermissions('purchasing.payables')
  createPayment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSupplierPaymentDto,
  ) {
    return this.payablesService.createPayment(tenantId, user.id, dto);
  }

  @Post('supplier-payments/:id/allocations')
  @RequirePermissions('purchasing.payables')
  allocatePayment(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AllocateDto,
  ) {
    return this.payablesService.allocatePayment(tenantId, user.id, id, dto);
  }

  @Post('supplier-payments/:id/void')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('purchasing.payables')
  voidPayment(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidDto,
  ) {
    return this.payablesService.voidPayment(tenantId, id, dto.reason);
  }

  // ---- Balances ----

  // Aging per supplier (current, 1–30, 31–60, 61–90, 90+ days past due)
  @Get('payables/aging')
  @RequireAnyPermission('purchasing.payables', 'purchasing.approve')
  aging(@CurrentTenant() tenantId: string, @Query() query: AgingQueryDto) {
    return this.payablesService.aging(tenantId, query.asOf);
  }

  @Get('suppliers/:id/statement')
  @RequireAnyPermission('purchasing.payables', 'purchasing.approve')
  statement(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: StatementQueryDto,
  ) {
    return this.payablesService.statement(tenantId, id, query.from, query.to);
  }

  // Approved invoices with an amount still owed (to allocate a payment)
  @Get('suppliers/:id/open-invoices')
  @RequirePermissions('purchasing.payables')
  openInvoices(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.payablesService.openInvoices(tenantId, id);
  }
}
