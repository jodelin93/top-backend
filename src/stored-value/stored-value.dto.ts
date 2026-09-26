import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class GiftCardLookupQueryDto {
  @IsString() @IsNotEmpty() @MaxLength(64) code: string;
}

export class ListStoredValueQueryDto {
  @IsIn(['gift_card', 'store_credit']) @IsOptional() type?:
    'gift_card' | 'store_credit';
  @IsIn(['pending', 'active', 'void']) @IsOptional() status?:
    'pending' | 'active' | 'void';
  @IsUUID() @IsOptional() customerId?: string;
  // Last 4 characters of a gift card
  @IsString() @IsOptional() @MaxLength(4) last4?: string;
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}

export class AdjustStoredValueDto {
  // Signed: + adds value, − removes it (never below zero)
  @IsNumber({ maxDecimalPlaces: 2 }) amount: number;
  @IsString() @IsNotEmpty() @MaxLength(500) reason: string;
}
