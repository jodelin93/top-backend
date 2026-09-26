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
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import {
  AllowApproval,
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { Idempotent } from '../common/idempotency/idempotent.decorator';
import { SettingsService } from '../settings/settings.service';
import { StoredValueService } from './stored-value.service';
import {
  AdjustStoredValueDto,
  GiftCardLookupQueryDto,
  ListStoredValueQueryDto,
} from './stored-value.dto';

/** Gift cards and store credit (spec §11) */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Stored value')
@ApiBearerAuth('JWT-auth')
@Controller('stored-value')
export class StoredValueController {
  constructor(
    private storedValue: StoredValueService,
    private settingsService: SettingsService,
  ) {}

  /**
   * Balance of a gift card by its code (till). Rate-limited: codes can't be guessed.
   * GET /stored-value/gift-cards/lookup?code=
   */
  @Get('gift-cards/lookup')
  @RequireAnyPermission('pos.sell', 'customers.finance.view')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  lookup(
    @CurrentTenant() tenantId: string,
    @Query() query: GiftCardLookupQueryDto,
  ) {
    return this.storedValue.lookupGiftCard(tenantId, query.code);
  }

  /** GET /stored-value/customers/:customerId : the customer's store credit (or null) */
  @Get('customers/:customerId')
  @RequireAnyPermission('pos.sell', 'customers.view')
  async storeCredit(
    @CurrentTenant() tenantId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return {
      account: await this.storedValue.findStoreCredit(tenantId, customerId),
    };
  }

  /**
   * Give a customer store credit (reason required). Above SECOND_PERSON_THRESHOLD
   * a manager's approval (X-Approval-Token) from someone else is needed, even
   * with customers.credit.manage.
   * POST /stored-value/customers/:customerId/credit
   */
  @Post('customers/:customerId/credit')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('customers.credit.manage')
  @AllowApproval()
  @Idempotent('stored_value.credit')
  async creditCustomer(
    @CurrentTenant() tenantId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: AdjustStoredValueDto,
    @CurrentUser() user: AuthUser,
    @Headers('x-approval-token') approvalToken?: string,
  ) {
    const { currencyCode } = await this.settingsService.getSettings(tenantId);
    return this.storedValue.creditCustomer(
      tenantId,
      customerId,
      dto.amount,
      dto.reason,
      currencyCode,
      { user, approvalToken },
    );
  }

  /** GET /stored-value?type=&status=&customerId=&last4=&page=&limit= */
  @Get()
  @RequirePermissions('customers.finance.view')
  list(
    @CurrentTenant() tenantId: string,
    @Query() query: ListStoredValueQueryDto,
  ) {
    return this.storedValue.list(tenantId, query);
  }

  /** GET /stored-value/:id : the account and its movements */
  @Get(':id')
  @RequirePermissions('customers.finance.view')
  entries(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.storedValue.entries(tenantId, id);
  }

  /**
   * POST /stored-value/:id/adjust { amount, reason }
   * Positive adjustments above SECOND_PERSON_THRESHOLD need a second person's
   * approval (X-Approval-Token), even with customers.credit.manage.
   */
  @Post(':id/adjust')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('customers.credit.manage')
  @AllowApproval()
  @Idempotent('stored_value.adjust')
  adjust(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustStoredValueDto,
    @CurrentUser() user: AuthUser,
    @Headers('x-approval-token') approvalToken?: string,
  ) {
    return this.storedValue.adjust(tenantId, id, dto.amount, dto.reason, {
      user,
      approvalToken,
    });
  }
}
