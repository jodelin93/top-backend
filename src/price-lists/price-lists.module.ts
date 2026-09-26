import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PriceList } from '../database/entities/price-list.entity';
import { PriceEntry } from '../database/entities/price-entry.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { PriceListsService } from './price-lists.service';
import { PricingService } from './pricing.service';
import { PriceListsController } from './price-lists.controller';

@Module({
  imports: [TypeOrmModule.forFeature([PriceList, PriceEntry, ProductVariant])],
  controllers: [PriceListsController],
  providers: [PriceListsService, PricingService],
  exports: [PricingService],
})
export class PriceListsModule {}
