import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Estimate } from '../database/entities/estimate.entity';
import { SettingsModule } from '../settings/settings.module';
import { PriceListsModule } from '../price-lists/price-lists.module';
import { TaxResolverService } from '../sales/tax-resolver.service';
import { EstimatesService } from './estimates.service';
import { EstimatesController } from './estimates.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Estimate]),
    SettingsModule,
    PriceListsModule,
  ],
  controllers: [EstimatesController],
  providers: [EstimatesService, TaxResolverService],
  exports: [EstimatesService],
})
export class EstimatesModule {}
