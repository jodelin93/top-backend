import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { CustomerProfileService } from './customer-profile.service';
import {
  CreateCustomerAddressDto,
  CreateCustomerContactDto,
  CreateCustomerNoteDto,
  UpdateCustomerAddressDto,
  UpdateCustomerContactDto,
} from './customer-profile.dto';

/** Addresses, contacts, internal notes and activity history of a customer */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Customers')
@ApiBearerAuth('JWT-auth')
@Controller('customers/:id')
export class CustomerProfileController {
  constructor(private profile: CustomerProfileService) {}

  @Get('addresses')
  @RequirePermissions('customers.view')
  addresses(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.profile.addresses(tenantId, id);
  }

  @Post('addresses')
  @RequirePermissions('customers.manage')
  addAddress(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCustomerAddressDto,
  ) {
    return this.profile.addAddress(tenantId, id, dto);
  }

  @Patch('addresses/:addressId')
  @RequirePermissions('customers.manage')
  updateAddress(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
    @Body() dto: UpdateCustomerAddressDto,
  ) {
    return this.profile.updateAddress(tenantId, id, addressId, dto);
  }

  @Delete('addresses/:addressId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('customers.manage')
  removeAddress(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('addressId', ParseUUIDPipe) addressId: string,
  ) {
    return this.profile.removeAddress(tenantId, id, addressId);
  }

  @Get('contacts')
  @RequirePermissions('customers.view')
  contacts(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.profile.contacts(tenantId, id);
  }

  @Post('contacts')
  @RequirePermissions('customers.manage')
  addContact(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCustomerContactDto,
  ) {
    return this.profile.addContact(tenantId, id, dto);
  }

  @Patch('contacts/:contactId')
  @RequirePermissions('customers.manage')
  updateContact(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
    @Body() dto: UpdateCustomerContactDto,
  ) {
    return this.profile.updateContact(tenantId, id, contactId, dto);
  }

  @Delete('contacts/:contactId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('customers.manage')
  removeContact(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('contactId', ParseUUIDPipe) contactId: string,
  ) {
    return this.profile.removeContact(tenantId, id, contactId);
  }

  /** Notes the user may see ("managers" notes only with customers.manage) */
  @Get('notes')
  @RequirePermissions('customers.view')
  notes(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.profile.notes(tenantId, id, user);
  }

  // A write: needs a customer write permission, not just customers.view. Cashiers
  // hold customers.create (not customers.manage) and add notes from the customer
  // screen (e.g. "prefers delivery on Fridays"), so either one is enough; deleting
  // notes stays with customers.manage.
  @Post('notes')
  @RequireAnyPermission('customers.create', 'customers.manage')
  addNote(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCustomerNoteDto,
  ) {
    return this.profile.addNote(tenantId, id, user, dto);
  }

  @Delete('notes/:noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequirePermissions('customers.manage')
  removeNote(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
  ) {
    return this.profile.removeNote(tenantId, id, noteId);
  }

  /** GET /customers/:id/activity : sales, returns, account, loyalty and notes */
  @Get('activity')
  @RequirePermissions('customers.view')
  activity(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.profile.activity(tenantId, id, user);
  }
}
