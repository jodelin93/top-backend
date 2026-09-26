import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StockLevel } from '../database/entities/stock-level.entity';
import { StockMovement } from '../database/entities/stock-movement.entity';
import { StockAdjustment } from '../database/entities/stock-adjustment.entity';
import { SettingsModule } from '../settings/settings.module';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { ReservationExpiryService } from './reservation-expiry.service';
import { StockCountsService } from './stock-counts.service';
import { StockCountsController } from './stock-counts.controller';
import { StockTransfersService } from './stock-transfers.service';
import { StockTransfersController } from './stock-transfers.controller';
import { StockProjectionService } from './stock-projection.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([StockLevel, StockMovement, StockAdjustment]),
    SettingsModule,
  ],
  controllers: [
    InventoryController,
    StockCountsController,
    StockTransfersController,
  ],
  providers: [
    InventoryService,
    ReservationExpiryService,
    StockCountsService,
    StockTransfersService,
    StockProjectionService,
  ],
  exports: [InventoryService],
})
export class InventoryModule {}
