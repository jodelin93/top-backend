import { PartialType } from '@nestjs/swagger';
import { CreateProductDto } from './create-product.dto';
import { IsEnum, IsOptional } from 'class-validator';
import { ProductStatus } from '../../database/entities/product.entity';

export class UpdateProductDto extends PartialType(CreateProductDto) {
  @IsEnum(ProductStatus)
  @IsOptional()
  status?: ProductStatus;
}
