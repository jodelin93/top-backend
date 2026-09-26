import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import {
  ProductStatus,
  ProductType,
} from '../../database/entities/product.entity';

export class ListProductsQueryDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  search?: string;

  @IsEnum(ProductStatus)
  @IsOptional()
  status?: ProductStatus;

  @IsEnum(ProductType)
  @IsOptional()
  productType?: ProductType;

  @IsUUID()
  @IsOptional()
  categoryId?: string;

  @IsUUID()
  @IsOptional()
  taxCategoryId?: string;

  // Comma-separated: products having any of these tags
  @IsString()
  @IsOptional()
  tags?: string;

  // Only products sold at this branch (assortment)
  @IsUUID()
  @IsOptional()
  branchId?: string;

  @IsUUID()
  @IsOptional()
  unitId?: string;
}
