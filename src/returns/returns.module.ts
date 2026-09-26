import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SaleReturn } from '../database/entities/sale-return.entity';
import { ExchangeLink } from '../database/entities/exchange-link.entity';
import { SettingsModule } from '../settings/settings.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { PaymentsModule } from '../payments/payments.module';
import { CustomersModule } from '../customers/customers.module';
import { StoredValueModule } from '../stored-value/stored-value.module';
import { SalesModule } from '../sales/sales.module';
import { ReturnsService } from './returns.service';
import { ReturnsController } from './returns.controller';
import { ExchangesService } from './exchanges.service';
import { ExchangesController } from './exchanges.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([SaleReturn, ExchangeLink]),
    SettingsModule,
    InventoryModule,
    ShiftsModule,
    PaymentsModule,
    CustomersModule,
    StoredValueModule,
    SalesModule,
  ],
  // Exchanges first: /returns/exchanges must not be taken for /returns/:id
  controllers: [ExchangesController, ReturnsController],
  providers: [ReturnsService, ExchangesService],
})
export class ReturnsModule {}
