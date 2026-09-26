import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Headers,
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
import { CrudController } from '../common/crud/crud-controller.factory';
import { Idempotent } from '../common/idempotency/idempotent.decorator';
import { ExpenseCategory } from '../database/entities/expense-category.entity';
import { ExpenseCategoriesService, ExpensesService } from './expenses.service';
import {
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  ListExpensesQueryDto,
  PayExpenseDto,
  RejectExpenseDto,
  UpdateExpenseCategoryDto,
  UpdateExpenseDto,
} from './expenses.dto';

@ApiTags('Expenses')
@ApiBearerAuth('JWT-auth')
@Controller('expense-categories')
export class ExpenseCategoriesController extends CrudController<ExpenseCategory>(
  CreateExpenseCategoryDto,
  UpdateExpenseCategoryDto,
  {
    entityType: 'expense_category',
    permission: 'expenses.approve',
    read: { anyOf: ['expenses.create', 'expenses.approve'] },
  },
) {
  constructor(service: ExpenseCategoriesService) {
    super(service);
  }
}

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Expenses')
@ApiBearerAuth('JWT-auth')
@Controller('expenses')
export class ExpensesController {
  constructor(private expensesService: ExpensesService) {}

  /** GET /expenses?status=&categoryId=&registerId=&shiftId=&from=&to=&search=&page=&limit= */
  @Get()
  @RequirePermissions('expenses.create')
  list(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: ListExpensesQueryDto,
  ) {
    return this.expensesService.list(tenantId, user, query);
  }

  @Get(':id')
  @RequirePermissions('expenses.create')
  findOne(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.expensesService.findOne(tenantId, user, id);
  }

  @Post()
  @RequirePermissions('expenses.create')
  @Idempotent('expense.create')
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateExpenseDto,
  ) {
    return this.expensesService.create(tenantId, user, dto);
  }

  @Patch(':id')
  @RequirePermissions('expenses.create')
  update(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpenseDto,
  ) {
    return this.expensesService.update(tenantId, user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('expenses.create')
  remove(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.expensesService.remove(tenantId, user, id);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('expenses.create')
  submit(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.expensesService.submit(tenantId, user, id);
  }

  /**
   * Approve (a different person than the creator/submitter; manager override
   * allowed). A creator who holds expenses.approve sends another person's
   * approval token (X-Approval-Token), which the service verifies.
   */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('expenses.approve')
  @AllowApproval()
  approve(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers(APPROVAL_HEADER) approvalToken?: string,
  ) {
    return this.expensesService.approve(tenantId, user, id, approvalToken);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('expenses.approve')
  @AllowApproval()
  reject(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectExpenseDto,
  ) {
    return this.expensesService.reject(tenantId, user, id, dto.reason);
  }

  /** Mark paid; cash from a till posts one movement to its open shift */
  @Post(':id/pay')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('expenses.create')
  @Idempotent('expense.pay')
  pay(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PayExpenseDto,
  ) {
    return this.expensesService.pay(tenantId, user, id, dto);
  }
}
