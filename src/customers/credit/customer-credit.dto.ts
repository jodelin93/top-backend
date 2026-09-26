import { Type } from 'class-transformer';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** POST /customers/:id/account/payments */
export class RecordCustomerPaymentDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
  // Cash, card, bank transfer, cheque... (not on account / gift card / store credit)
  @IsUUID() paymentMethodId: string;
  // Cheque / transfer number, card approval code
  @IsString() @IsOptional() @MaxLength(255) reference?: string;
  // Register whose open shift receives cash payments
  @IsUUID() @IsOptional() registerId?: string;
  @IsString() @IsOptional() @MaxLength(500) note?: string;
  // One per payment attempt: a retried request never posts twice
  @IsString() @IsOptional() @Length(8, 100) idempotencyKey?: string;
}

/** POST /customers/:id/account/adjustments */
export class AdjustCustomerAccountDto {
  // Signed: + the customer owes more, − the customer owes less
  @IsNumber({ maxDecimalPlaces: 2 }) amount: number;
  @IsString() @IsNotEmpty() @MaxLength(500) reason: string;
  // opening_balance: only as the first entry of the account
  @IsIn(['adjustment', 'opening_balance'])
  @IsOptional()
  type?: 'adjustment' | 'opening_balance';
}

export class CreditEntriesQueryDto {
  @IsDateString() @IsOptional() from?: string;
  @IsDateString() @IsOptional() to?: string;
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(200) @IsOptional() limit?: number;
}

export class StatementQueryDto {
  @IsDateString() from: string;
  @IsDateString() to: string;
}

export class AgingQueryDto {
  // Default: today
  @IsDateString() @IsOptional() asOf?: string;
  // Only customers with a balance (default true)
  @IsIn(['true', 'false']) @IsOptional() nonZero?: 'true' | 'false';
  @IsString() @IsOptional() @MaxLength(100) search?: string;
}
