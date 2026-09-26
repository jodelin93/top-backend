import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TaxCategory } from '../database/entities/tax-category.entity';
import { TaxRate } from '../database/entities/tax-rate.entity';
import { TaxCategoriesService } from './tax-categories.service';
import { TaxCategoriesController } from './tax-categories.controller';

@Module({
  imports: [TypeOrmModule.forFeature([TaxCategory, TaxRate])],
  controllers: [TaxCategoriesController],
  providers: [TaxCategoriesService],
  exports: [TaxCategoriesService],
})
export class TaxCategoriesModule {}
