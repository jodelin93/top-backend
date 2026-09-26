import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import {
  DiscountScope,
  DiscountStatus,
  DiscountType,
} from '../database/entities/discount.entity';

export class CreateDiscountDto {
  @IsString() @IsNotEmpty() @MaxLength(50) code: string;
  @IsObject() name: Record<string, string>;
  @IsObject() @IsOptional() description?: Record<string, string> | null;
  @IsEnum(DiscountType) discountType: DiscountType;
  @IsEnum(DiscountScope) scope: DiscountScope;
  // Amount off for fixed_amount discounts
  @IsNumber() @Min(0) @IsOptional() value?: number | null;
  // Percent off for percentage discounts
  @IsNumber() @Min(0) @Max(100) @IsOptional() percentage?: number | null;
  @IsInt() @Min(1) @IsOptional() buyQuantity?: number | null;
  @IsInt() @Min(1) @IsOptional() getQuantity?: number | null;
  @IsNumber() @Min(0) @IsOptional() minPurchaseAmount?: number | null;
  @IsNumber() @Min(0) @IsOptional() maxDiscountAmount?: number | null;
  @IsInt() @Min(1) @IsOptional() usageLimit?: number | null;
  // Uses allowed per customer (a sale using the code then needs a customer)
  @IsInt() @Min(1) @IsOptional() usageLimitPerCustomer?: number | null;
  @IsDateString() @IsOptional() validFrom?: string | null;
  @IsDateString() @IsOptional() validTo?: string | null;
  @IsArray()
  @IsUUID('all', { each: true })
  @IsOptional()
  applicableProductIds?: string[];
  @IsArray()
  @IsUUID('all', { each: true })
  @IsOptional()
  applicableCategoryIds?: string[];
  @IsArray()
  @IsUUID('all', { each: true })
  @IsOptional()
  excludedProductIds?: string[];
  @IsInt() @IsOptional() priority?: number;
}

export class UpdateDiscountDto extends PartialType(CreateDiscountDto) {
  @IsEnum(DiscountStatus) @IsOptional() status?: DiscountStatus;
}
