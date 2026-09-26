import { EstimatesModule } from '../estimates/estimates.module';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Sale } from '../database/entities/sale.entity';
import { SettingsModule } from '../settings/settings.module';
import { PriceListsModule } from '../price-lists/price-lists.module';
import { DiscountsModule } from '../discounts/discounts.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { PaymentsModule } from '../payments/payments.module';
import { CustomersModule } from '../customers/customers.module';
import { StoredValueModule } from '../stored-value/stored-value.module';
import { TaxResolverService } from './tax-resolver.service';
import { SalesService } from './sales.service';
import { PosService } from './pos.service';
import { PosController, SalesController } from './sales.controller';
import { ConflictCasesService } from './conflict-cases.service';
import { ConflictCasesController } from './conflict-cases.controller';

@Module({
  imports: [
    EstimatesModule,
    TypeOrmModule.forFeature([Sale]),
    SettingsModule,
    PriceListsModule,
    DiscountsModule,
    InventoryModule,
    ShiftsModule,
    PaymentsModule,
    CustomersModule,
    StoredValueModule,
  ],
  controllers: [SalesController, PosController, ConflictCasesController],
  providers: [
    SalesService,
    PosService,
    TaxResolverService,
    ConflictCasesService,
  ],
  exports: [SalesService, ConflictCasesService, PosService],
})
export class SalesModule {}
