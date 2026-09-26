import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProductsService } from './products.service';
import { ProductsController } from './products.controller';
import { ProductMediaController } from './product-media.controller';
import { AttributesController } from './attributes.controller';
import { AttributesService } from './attributes.service';
import { ProductBarcodesService } from './product-barcodes.service';
import { ProductImagesService } from './product-images.service';
import { Product } from '../database/entities/product.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { Category } from '../database/entities/category.entity';
import { AttributeDefinition } from '../database/entities/attribute-definition.entity';
import { AttributeValue } from '../database/entities/attribute-value.entity';
import { ProductBarcode } from '../database/entities/product-barcode.entity';
import { ProductImage } from '../database/entities/product-image.entity';
import { UnitsController } from './units.controller';
import { UnitsService } from './units.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Product,
      ProductVariant,
      Category,
      AttributeDefinition,
      AttributeValue,
      ProductBarcode,
      ProductImage,
    ]),
  ],
  controllers: [
    ProductsController,
    ProductMediaController,
    AttributesController,
    UnitsController,
  ],
  providers: [
    ProductsService,
    ProductBarcodesService,
    ProductImagesService,
    AttributesService,
    UnitsService,
  ],
  exports: [ProductsService, ProductBarcodesService],
})
export class ProductsModule {}
