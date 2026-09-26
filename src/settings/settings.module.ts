import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { Tenant } from '../database/entities/tenant.entity';
import { Branch } from '../database/entities/branch.entity';
import { Register } from '../database/entities/register.entity';
import { Warehouse } from '../database/entities/warehouse.entity';
import { InventoryLocation } from '../database/entities/inventory-location.entity';
import { PaymentMethod } from '../database/entities/payment-method.entity';
import { TaxRate } from '../database/entities/tax-rate.entity';
import { BranchWarehouse } from '../database/entities/branch-warehouse.entity';
import { SettingsService } from './settings.service';
import { SettingsVersion } from './settings-version.entity';
import {
  BranchesService,
  BranchWarehousesService,
  LocationsService,
  PaymentMethodsService,
  RegistersService,
  TaxRatesService,
  WarehousesService,
} from './settings-resources.service';
import {
  BranchesController,
  BranchWarehousesController,
  LocationsController,
  PaymentMethodsController,
  RegistersController,
  SettingsController,
  TaxRatesController,
  WarehousesController,
} from './settings.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Tenant,
      Branch,
      Register,
      Warehouse,
      InventoryLocation,
      PaymentMethod,
      TaxRate,
      SettingsVersion,
      BranchWarehouse,
    ]),
    StorageModule,
  ],
  controllers: [
    SettingsController,
    BranchesController,
    RegistersController,
    WarehousesController,
    LocationsController,
    BranchWarehousesController,
    PaymentMethodsController,
    TaxRatesController,
  ],
  providers: [
    SettingsService,
    BranchesService,
    RegistersService,
    WarehousesService,
    LocationsService,
    BranchWarehousesService,
    PaymentMethodsService,
    TaxRatesService,
  ],
  exports: [SettingsService, RegistersService, PaymentMethodsService],
})
export class SettingsModule {}
