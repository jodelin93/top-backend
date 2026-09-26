import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_MONEY } from '../common/validation/money';

export class SetMethodProviderDto {
  @IsString() @IsNotEmpty() @MaxLength(50) provider: string;
}

export class SettlementLineInput {
  @IsString() @IsOptional() @MaxLength(255) reference?: string;
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-MAX_MONEY)
  @Max(MAX_MONEY)
  amount: number;
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-MAX_MONEY)
  @Max(MAX_MONEY)
  @IsOptional()
  fee?: number;
  @IsDateString() @IsOptional() date?: string;
}

export class ImportSettlementDto {
  @IsString() @IsNotEmpty() @MaxLength(50) provider: string;
  @IsString() @IsOptional() @MaxLength(100) reference?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => SettlementLineInput)
  lines: SettlementLineInput[];
}

// Multipart fields sent with a CSV upload
export class UploadSettlementDto {
  @IsString() @IsNotEmpty() @MaxLength(50) provider: string;
  @IsString() @IsOptional() @MaxLength(100) reference?: string;
}

export class ResolveLineDto {
  @IsString() @IsNotEmpty() @MaxLength(255) note: string;
  @IsUUID() @IsOptional() paymentId?: string;
}

export class ResolvePaymentDto {
  @IsString() @IsNotEmpty() @MaxLength(255) note: string;
}

export class UnmatchedQueryDto {
  @IsString() @IsOptional() @MaxLength(50) provider?: string;
}

export class BatchListQueryDto {
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}
