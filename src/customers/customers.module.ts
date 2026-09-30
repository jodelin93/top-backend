import { Module } from '@nestjs/common';
import { SettingsModule } from '../settings/settings.module';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Customer } from '../database/entities/customer.entity';
import { CustomerGroup } from '../database/entities/customer-group.entity';
import { CustomerFieldDefinition } from '../database/entities/customer-field-definition.entity';
import { CustomerConsentEvent } from '../database/entities/customer-consent-event.entity';
import { PriceList } from '../database/entities/price-list.entity';
import { CustomersService } from './customers.service';
import { CustomersController } from './customers.controller';
import { CustomersAdminController } from './customers-admin.controller';
import {
  CustomerFieldsController,
  CustomerGroupsController,
} from './customer-settings.controller';
import { CustomerGroupsService } from './customer-groups.service';
import { CustomerFieldsService } from './customer-fields.service';
import { CustomerDuplicatesService } from './customer-duplicates.service';
import { CustomerMergeService } from './customer-merge.service';
import { CustomerAnonymizeService } from './customer-anonymize.service';
import { ShiftsModule } from '../shifts/shifts.module';
import { CustomerCreditService } from './credit/customer-credit.service';
import {
  CustomerAccountController,
  CustomerAccountsReportController,
} from './credit/customer-credit.controller';
import { CustomerProfileService } from './customer-profile.service';
import { CustomerProfileController } from './customer-profile.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Customer,
      CustomerGroup,
      CustomerFieldDefinition,
      CustomerConsentEvent,
      PriceList,
    ]),
    ShiftsModule,
    SettingsModule,
  ],
  // The admin controller first: its static routes (/customers/duplicates) must win over /customers/:id
  controllers: [
    CustomersAdminController,
    CustomerAccountController,
    CustomerAccountsReportController,
    CustomerProfileController,
    CustomersController,
    CustomerGroupsController,
    CustomerFieldsController,
  ],
  providers: [
    CustomersService,
    CustomerGroupsService,
    CustomerFieldsService,
    CustomerDuplicatesService,
    CustomerMergeService,
    CustomerAnonymizeService,
    CustomerCreditService,
    CustomerProfileService,
  ],
  exports: [CustomersService, CustomerCreditService],
})
export class CustomersModule {}
