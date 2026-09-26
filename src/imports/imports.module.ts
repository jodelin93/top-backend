import { Module } from '@nestjs/common';
import { ProductsModule } from '../products/products.module';
import { ImportsController } from './imports.controller';
import { ImportsService } from './imports.service';

@Module({
  imports: [ProductsModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
