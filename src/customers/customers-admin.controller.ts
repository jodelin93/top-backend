import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
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
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CustomerConsentEvent } from '../database/entities/customer-consent-event.entity';
import { Customer } from '../database/entities/customer.entity';
import { CustomersService, customerForViewer } from './customers.service';
import {
  AnonymiseResult,
  CustomerAnonymizeService,
} from './customer-anonymize.service';
import {
  CustomerDuplicatesService,
  DuplicateCandidate,
  DuplicatePair,
} from './customer-duplicates.service';
import { CustomerMergeService, MergeResult } from './customer-merge.service';
import {
  DuplicateCheckQueryDto,
  DuplicatesQueryDto,
  MergeCustomersDto,
} from './customers.dto';

/**
 * Duplicate detection, merging, anonymisation and consent history.
 * Registered before the CRUD controller so /customers/duplicates isn't taken for an id.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Customers')
@ApiBearerAuth('JWT-auth')
@Controller('customers')
export class CustomersAdminController {
  constructor(
    private customers: CustomersService,
    private duplicates: CustomerDuplicatesService,
    private mergeService: CustomerMergeService,
    private anonymizeService: CustomerAnonymizeService,
  ) {}

  /** GET /customers/duplicates?limit= : likely duplicate pairs to review */
  @Get('duplicates')
  @RequirePermissions('customers.merge')
  findDuplicates(
    @CurrentTenant() tenantId: string,
    @Query() query: DuplicatesQueryDto,
  ): Promise<DuplicatePair[]> {
    return this.duplicates.findPairs(tenantId, query.limit ?? 50);
  }

  /** GET /customers/duplicate-check?email=&phone=&firstName=&lastName=&excludeId= */
  @Get('duplicate-check')
  @RequirePermissions('customers.view')
  async checkDuplicates(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: DuplicateCheckQueryDto,
  ): Promise<DuplicateCandidate[]> {
    const matches = await this.duplicates.findMatches(tenantId, query);
    return matches.map((match) => ({
      ...match,
      customer: customerForViewer(match.customer, user.permissions),
    }));
  }

  /** POST /customers/merge { survivorId, mergedId, choices } */
  @Post('merge')
  @RequirePermissions('customers.merge')
  @HttpCode(HttpStatus.OK)
  merge(
    @CurrentTenant() tenantId: string,
    @Body() dto: MergeCustomersDto,
  ): Promise<MergeResult> {
    return this.mergeService.merge(
      tenantId,
      dto.survivorId,
      dto.mergedId,
      dto.choices ?? {},
    );
  }

  /** GET /customers/:id/consent-events : marketing consent history, newest first */
  @Get(':id/consent-events')
  @RequirePermissions('customers.view')
  consentHistory(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerConsentEvent[]> {
    return this.customers.consentHistory(tenantId, id);
  }

  /** GET /customers/:id/merged-records : customers that were merged into this one */
  @Get(':id/merged-records')
  @RequirePermissions('customers.view')
  async mergedRecords(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Customer[]> {
    const records = await this.mergeService.mergedInto(tenantId, id);
    return records.map((c) => customerForViewer(c, user.permissions));
  }

  /**
   * POST /customers/:id/anonymize : erase the customer's personal data (right to
   * erasure), keeping the record and its sales. 409 while money is owed either way.
   */
  @Post(':id/anonymize')
  @RequirePermissions('customers.manage')
  @HttpCode(HttpStatus.OK)
  anonymize(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AnonymiseResult> {
    return this.anonymizeService.anonymize(tenantId, id);
  }
}
