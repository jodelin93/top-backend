import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud-controller.factory';
import { CustomerGroup } from '../database/entities/customer-group.entity';
import { CustomerFieldDefinition } from '../database/entities/customer-field-definition.entity';
import { CustomerGroupsService } from './customer-groups.service';
import { CustomerFieldsService } from './customer-fields.service';
import {
  CreateCustomerFieldDto,
  CreateCustomerGroupDto,
  UpdateCustomerFieldDto,
  UpdateCustomerGroupDto,
} from './customer-settings.dto';

/** Customer groups (name, default price list, discount %) */
@ApiTags('Customers')
@ApiBearerAuth('JWT-auth')
@Controller('customer-groups')
export class CustomerGroupsController extends CrudController<CustomerGroup>(
  CreateCustomerGroupDto,
  UpdateCustomerGroupDto,
  {
    entityType: 'customer_group',
    permission: 'customers.manage',
    read: 'customers.view',
  },
) {
  constructor(service: CustomerGroupsService) {
    super(service);
  }
}

/** Store-defined customer fields; values live in customers.metadata.customFields */
@ApiTags('Customers')
@ApiBearerAuth('JWT-auth')
@Controller('customer-fields')
export class CustomerFieldsController extends CrudController<CustomerFieldDefinition>(
  CreateCustomerFieldDto,
  UpdateCustomerFieldDto,
  {
    entityType: 'customer_field',
    permission: 'customers.manage',
    read: 'customers.view',
  },
) {
  constructor(service: CustomerFieldsService) {
    super(service);
  }
}
