import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Length,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import {
  ExpensePaymentMethod,
  ExpenseStatus,
} from '../database/entities/expense.entity';
import {
  IsNotFutureDate,
  IsOnOrAfterField,
} from '../common/validation/date-rules';

export class CreateExpenseCategoryDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{1,50}$/) code: string;
  @IsString() @MinLength(1) @MaxLength(255) name: string;
  @IsString() @MaxLength(500) @IsOptional() description?: string | null;
  @IsBoolean() @IsOptional() isActive?: boolean;
}

export class UpdateExpenseCategoryDto {
  @IsString() @Matches(/^[A-Za-z0-9_-]{1,50}$/) @IsOptional() code?: string;
  @IsString() @MinLength(1) @MaxLength(255) @IsOptional() name?: string;
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(500)
  @IsOptional()
  description?: string | null;
  @IsBoolean() @IsOptional() isActive?: boolean;
}

export class CreateExpenseDto {
  // YYYY-MM-DD, defaults to today
  @IsDateString() @IsNotFutureDate() @IsOptional() expenseDate?: string;
  @IsUUID() @IsOptional() categoryId?: string;
  // Store currency. Paid in another accepted currency: worked out from tenderedAmount
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) amount: number;
  // Paid in another currency the store accepts (e.g. HTG), valued at the sell rate
  @IsString() @Length(3, 3) @IsOptional() currencyCode?: string;
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsOptional()
  tenderedAmount?: number;
  @IsString() @MinLength(2) @MaxLength(500) description: string;
  @IsString() @MaxLength(255) @IsOptional() payee?: string;
  @IsString() @MaxLength(255) @IsOptional() receiptReference?: string;
  @IsEnum(ExpensePaymentMethod)
  @IsOptional()
  paymentMethod?: ExpensePaymentMethod;
  // Till the cash comes from (cash expenses paid at a register)
  @IsUUID() @IsOptional() registerId?: string;
  @IsString() @MaxLength(1000) @IsOptional() notes?: string;
  // Submit straight away instead of saving a draft
  @IsBoolean() @IsOptional() submit?: boolean;
}

export class UpdateExpenseDto {
  @IsDateString() @IsNotFutureDate() @IsOptional() expenseDate?: string;
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  @IsOptional()
  categoryId?: string | null;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @IsOptional() amount?: number;
  // With amount: the currency it was paid in (store currency = none)
  @IsString() @Length(3, 3) @IsOptional() currencyCode?: string;
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @IsOptional()
  tenderedAmount?: number;
  @IsString() @MinLength(2) @MaxLength(500) @IsOptional() description?: string;
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  payee?: string | null;
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(255)
  @IsOptional()
  receiptReference?: string | null;
  @IsEnum(ExpensePaymentMethod)
  @IsOptional()
  paymentMethod?: ExpensePaymentMethod;
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  @IsOptional()
  registerId?: string | null;
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  notes?: string | null;
}

export class RejectExpenseDto {
  @IsString() @MinLength(2) @MaxLength(500) reason: string;
}

export class PayExpenseDto {
  // For cash paid from a till: the register whose open shift pays it
  @IsUUID() @IsOptional() registerId?: string;
  @IsString() @MaxLength(255) @IsOptional() reference?: string;
}

export class ListExpensesQueryDto {
  @IsEnum(ExpenseStatus) @IsOptional() status?: ExpenseStatus;
  @IsUUID() @IsOptional() categoryId?: string;
  @IsUUID() @IsOptional() registerId?: string;
  @IsUUID() @IsOptional() shiftId?: string;
  @IsIn(Object.values(ExpensePaymentMethod))
  @IsOptional()
  paymentMethod?: ExpensePaymentMethod;
  @IsDateString() @IsOptional() from?: string;
  @IsDateString() @IsOnOrAfterField('from') @IsOptional() to?: string;
  @IsString() @MaxLength(100) @IsOptional() search?: string;
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}
