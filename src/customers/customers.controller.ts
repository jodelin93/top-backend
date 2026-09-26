import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { CrudController } from '../common/crud/crud-controller.factory';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Customer } from '../database/entities/customer.entity';
import { CustomersService, customerForViewer } from './customers.service';
import {
  CreateCustomerDto,
  ListCustomersQueryDto,
  UpdateCustomerDto,
} from './customers.dto';

@ApiTags('Customers')
@ApiBearerAuth('JWT-auth')
@Controller('customers')
export class CustomersController extends CrudController<Customer>(
  CreateCustomerDto,
  UpdateCustomerDto,
  {
    entityType: 'customer',
    permission: {
      create: 'customers.create',
      update: 'customers.manage',
      remove: 'customers.manage',
    },
    read: 'customers.view',
  },
) {
  constructor(private customersService: CustomersService) {
    super(customersService);
  }

  /**
   * Search customers by name, code, email or phone
   * GET /customers?search=&status=
   */
  @Get()
  @RequirePermissions('customers.view')
  async findAll(
    @CurrentTenant() tenantId: string,
    @Query() query: ListCustomersQueryDto = {},
    @CurrentUser() user?: AuthUser,
  ): Promise<Customer[]> {
    const customers = await this.customersService.search(tenantId, query);
    return customers.map((c) => customerForViewer(c, user?.permissions));
  }

  /**
   * GET /customers/:id : personal details (date of birth, tax number, addresses)
   * only for customers.manage / customers.finance.view, see customerForViewer
   */
  @Get(':id')
  @RequirePermissions('customers.view')
  async findOne(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user?: AuthUser,
  ): Promise<Customer> {
    const customer = await this.customersService.findOne(tenantId, id);
    return customerForViewer(customer, user?.permissions);
  }
}
