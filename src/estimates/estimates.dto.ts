import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsQuantity } from '../common/dto/quantity.decorator';
import { CartDiscountInput } from '../sales/sales.dto';
import { EstimateStatus } from '../database/entities/estimate.entity';

export class EstimateItemInput {
  @IsUUID() variantId: string;
  // Whole units, or up to the unit's precision for measured items (1.25 kg)
  @IsQuantity({ max: 100000 }) quantity: number;
  // Negotiated price; omitted = the catalog price
  @IsNumber() @Min(0) @IsOptional() unitPrice?: number;
  @IsNumber() @Min(0) @Max(100) @IsOptional() discountPercent?: number;
  @IsString() @IsOptional() @MaxLength(500) note?: string;
}

export class CreateEstimateDto {
  @IsUUID() @IsOptional() customerId?: string | null;
  // For a prospect without a customer record
  @IsString() @IsOptional() @MaxLength(255) customerName?: string | null;
  @IsUUID() @IsOptional() branchId?: string | null;
  @IsDateString() @IsOptional() issueDate?: string;
  // Defaults to 30 days after the issue date
  @IsDateString() @IsOptional() validUntil?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => EstimateItemInput)
  items: EstimateItemInput[];

  @ValidateNested()
  @Type(() => CartDiscountInput)
  @IsOptional()
  cartDiscount?: CartDiscountInput | null;

  @IsString() @IsOptional() @MaxLength(1000) notes?: string | null;
  @IsString() @IsOptional() @MaxLength(2000) terms?: string | null;
}

export class UpdateEstimateDto extends PartialType(CreateEstimateDto) {}

export class ListEstimatesQueryDto {
  @IsString() @IsOptional() @MaxLength(100) search?: string;
  @IsEnum(EstimateStatus) @IsOptional() status?: EstimateStatus;
  @IsUUID() @IsOptional() customerId?: string;
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}
