import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsNumber,
  IsUUID,
  Min,
  Max,
  IsArray,
  ArrayMaxSize,
  MaxLength,
  Matches,
  ValidateIf,
} from 'class-validator';
import { ProductType } from '../../database/entities/product.entity';
import {
  IsLocalizedText,
  IsBoundedMetadata,
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
} from '../../common/validation/localized-text';
import { MAX_MONEY } from '../../common/validation/money';

export class CreateProductDto {
  @IsString()
  @IsNotEmpty()
  sku: string;

  @IsLocalizedText({ maxLength: MAX_NAME_LENGTH, requireOne: true })
  name: Record<string, string>; // { en: 'Product Name', fr: 'Nom du produit' }

  @IsLocalizedText({ maxLength: MAX_DESCRIPTION_LENGTH })
  @IsOptional()
  description?: Record<string, string>;

  @IsEnum(ProductType)
  @IsOptional()
  productType?: ProductType;

  @IsUUID()
  @IsOptional()
  categoryId?: string;

  // Null / omitted: the store's default tax rate applies
  @IsUUID()
  @IsOptional()
  taxCategoryId?: string | null;

  @IsString()
  @IsOptional()
  brand?: string;

  @IsString()
  @IsOptional()
  manufacturer?: string;

  @IsString()
  @IsOptional()
  barcode?: string;

  // Simple products: PLU / scale item code of the default variant (1–6 digits),
  // read from weighted and price-embedded barcodes; null clears it
  @ValidateIf((_, v) => v !== null && v !== undefined && v !== '')
  @IsString()
  @Matches(/^\s*\d{1,6}\s*$/, { message: 'PLU code must be 1 to 6 digits' })
  pluCode?: string | null;

  @IsBoolean()
  @IsOptional()
  isSerialized?: boolean;

  @IsBoolean()
  @IsOptional()
  isBatchTracked?: boolean;

  // Ignored (D018: negative stock is never allowed); kept so older clients don't fail
  @IsBoolean()
  @IsOptional()
  allowBackorder?: boolean;

  // Free labels, normalized (trimmed, lower-case, unique; 30 max)
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  tags?: string[];

  // Default unit of measure; null = by the piece
  @IsUUID()
  @IsOptional()
  unitId?: string | null;

  // Branch assortment: only these branches sell it; empty = every branch
  @IsArray()
  @IsOptional()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  branchIds?: string[];

  // False for services / non-stock items (no stock movements when sold)
  @IsBoolean()
  @IsOptional()
  isStockTracked?: boolean;

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
  reorderPoint?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  reorderQuantity?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  weight?: number;

  @IsString()
  @IsOptional()
  weightUnit?: string;

  @IsNumber()
  @IsOptional()
  @Min(0)
  length?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  width?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  height?: number;

  @IsString()
  @IsOptional()
  dimensionUnit?: string;

  @IsBoundedMetadata()
  @IsOptional()
  metadata?: Record<string, any>;

  // Selling price and unit cost of the default variant (simple products)
  @IsNumber({ maxDecimalPlaces: 4 })
  @IsOptional()
  @Min(0)
  @Max(MAX_MONEY)
  price?: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @IsOptional()
  @Min(0)
  @Max(MAX_MONEY)
  cost?: number;
}
