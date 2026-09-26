import { OmitType, PartialType } from '@nestjs/swagger';
import {
  IsEnum,
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsUUID,
  Min,
  Max,
  IsArray,
  Matches,
  ValidateIf,
} from 'class-validator';
import {
  IsLocalizedText,
  IsBoundedMetadata,
  MAX_NAME_LENGTH,
} from '../../common/validation/localized-text';
import { MAX_MONEY } from '../../common/validation/money';
import { VariantStatus } from '../../database/entities/product-variant.entity';

export class CreateVariantDto {
  @IsUUID()
  @IsNotEmpty()
  productId: string;

  @IsString()
  @IsNotEmpty()
  sku: string;

  @IsString()
  @IsOptional()
  barcode?: string;

  // PLU / scale item code (1–6 digits) for weighted and price-embedded barcodes;
  // null clears it
  @ValidateIf((_, v) => v !== null && v !== undefined && v !== '')
  @IsString()
  @Matches(/^\s*\d{1,6}\s*$/, { message: 'PLU code must be 1 to 6 digits' })
  pluCode?: string | null;

  @IsLocalizedText({ maxLength: MAX_NAME_LENGTH })
  @IsOptional()
  name?: Record<string, string>;

  @IsNumber({ maxDecimalPlaces: 4 })
  @IsOptional()
  @Min(0)
  @Max(MAX_MONEY)
  cost?: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @IsOptional()
  @Min(0)
  @Max(MAX_MONEY)
  price?: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @IsOptional()
  @Min(0)
  @Max(MAX_MONEY)
  compareAtPrice?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  minStockLevel?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  maxStockLevel?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  weight?: number;

  @IsString()
  @IsOptional()
  weightUnit?: string;

  @IsString()
  @IsOptional()
  imageUrl?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  sortOrder?: number;

  @IsBoundedMetadata()
  @IsOptional()
  metadata?: Record<string, any>;

  @IsArray()
  @IsOptional()
  attributes?: Array<{
    attributeId: string;
    value: string;
  }>;
}

// Body of POST /products/:id/variants (product comes from the URL)
export class CreateProductVariantDto extends OmitType(CreateVariantDto, [
  'productId',
] as const) {}

export class UpdateVariantDto extends PartialType(
  OmitType(CreateVariantDto, ['productId', 'attributes'] as const),
) {
  @IsEnum(VariantStatus)
  @IsOptional()
  status?: VariantStatus;
}
