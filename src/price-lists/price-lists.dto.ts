import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
  Length,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import {
  PriceListStatus,
  PriceListType,
} from '../database/entities/price-list.entity';
import { IsOnOrAfterField } from '../common/validation/date-rules';

export class CreatePriceListDto {
  @IsString() @IsNotEmpty() @MaxLength(50) code: string;
  @IsObject() name: Record<string, string>;
  @IsObject() @IsOptional() description?: Record<string, string> | null;
  @IsEnum(PriceListType) @IsOptional() priceListType?: PriceListType;
  @IsString() @Length(3, 3) currencyCode: string;
  @IsUUID() @IsOptional() branchId?: string | null;
  @IsDateString() @IsOptional() validFrom?: string | null;
  @IsDateString()
  @IsOnOrAfterField('validFrom')
  @IsOptional()
  validTo?: string | null;
  @IsInt() @IsOptional() priority?: number;
}

export class UpdatePriceListDto extends PartialType(CreatePriceListDto) {
  @IsEnum(PriceListStatus) @IsOptional() status?: PriceListStatus;
}

export class PriceEntryInput {
  @IsUUID() variantId: string;
  @IsNumber() @Min(0) price: number;
  @IsNumber() @Min(0) @IsOptional() compareAtPrice?: number | null;
  @IsInt() @Min(1) @IsOptional() minQuantity?: number | null;
}

export class SetPriceEntriesDto {
  @IsArray()
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => PriceEntryInput)
  entries: PriceEntryInput[];
}
