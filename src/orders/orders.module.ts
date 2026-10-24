import { Module } from '@nestjs/common';
import { SalesModule } from '../sales/sales.module';
import { ShiftsModule } from '../shifts/shifts.module';
import { SettingsModule } from '../settings/settings.module';
import { OrdersService } from './orders.service';
import { OrdersController } from './orders.controller';

@Module({
  imports: [SalesModule, ShiftsModule, SettingsModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
