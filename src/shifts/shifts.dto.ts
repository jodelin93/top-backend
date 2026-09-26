import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ShiftStatus } from '../database/entities/shift.entity';
import { CashMovementType } from '../database/entities/cash-movement.entity';
import { ShiftCorrectionType } from '../database/entities/shift-correction.entity';
import { DrawerStatus } from '../database/entities/drawer.entity';

export class DenominationCountInput {
  @IsNumber() @Min(0.01) value: number;
  @IsInt() @Min(0) @Max(1_000_000) quantity: number;
}

export class OpenShiftDto {
  @IsUUID() registerId: string;
  // Registers with several drawers: which one (default: the first free one)
  @IsUUID() @IsOptional() drawerId?: string;

  // Either the float amount, or a denomination count (the total is used)
  @IsNumber() @Min(0) @IsOptional() openingFloat?: number;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => DenominationCountInput)
  @IsOptional()
  denominations?: DenominationCountInput[];

  @IsString() @MaxLength(500) @IsOptional() notes?: string;
}

export class StartCloseDto {
  // Blind count: the cashier counts without seeing the expected amount
  @IsBoolean() @IsOptional() blind?: boolean;
}

export class CountDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => DenominationCountInput)
  @IsOptional()
  denominations?: DenominationCountInput[];

  // Used when no denominations are given
  @IsNumber() @Min(0) @IsOptional() countedCash?: number;

  // Cash counted in each other currency the drawer took (e.g. HTG)
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => ForeignCountInput)
  @IsOptional()
  foreignCounts?: ForeignCountInput[];
}

export class ForeignCountInput {
  @IsString() @Length(3, 3) currencyCode: string;
  @IsNumber() @Min(0) countedCash: number;
}

export class CloseShiftDto extends CountDto {
  // Required: a retried close with the same key returns the first result
  @IsString() @MinLength(8) @MaxLength(100) idempotencyKey: string;
  @IsString() @MaxLength(500) @IsOptional() varianceReason?: string;
  @IsString() @MaxLength(500) @IsOptional() notes?: string;
}

export const MANUAL_MOVEMENT_TYPES = [
  CashMovementType.PAID_IN,
  CashMovementType.PAID_OUT,
  CashMovementType.SAFE_DROP,
] as const;
export type ManualMovementType = (typeof MANUAL_MOVEMENT_TYPES)[number];

export class CreateCashMovementDto {
  @IsIn(MANUAL_MOVEMENT_TYPES) type: ManualMovementType;
  @IsNumber() @Min(0.01) amount: number;
  @IsString() @MinLength(2) @MaxLength(500) reason: string;
  @IsString() @MaxLength(255) @IsOptional() reference?: string;
  // Retried requests with the same key do not post twice
  @IsString() @MaxLength(100) @IsOptional() idempotencyKey?: string;
}

export class ListShiftsQueryDto {
  @IsIn(Object.values(ShiftStatus)) @IsOptional() status?: ShiftStatus;
  @IsUUID() @IsOptional() registerId?: string;
  @IsUUID() @IsOptional() userId?: string;
  @IsDateString() @IsOptional() from?: string;
  @IsDateString() @IsOptional() to?: string;
  // Only closed shifts whose variance is above the tolerance
  @IsIn(['true', 'false']) @IsOptional() varianceOnly?: 'true' | 'false';
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}

export class CurrentShiftQueryDto {
  @IsUUID() registerId: string;
}

export class DenominationsQueryDto {
  @IsString() @Length(3, 3) @IsOptional() currencyCode?: string;
}

export class SetDenominationsDto {
  @IsString() @Length(3, 3) currencyCode: string;

  // Empty list = go back to the built-in defaults
  @IsArray()
  @ArrayMaxSize(30)
  @IsNumber({}, { each: true })
  denominations: number[];
}

/** Close and hand the drawer to the next cashier (their opening float = the count) */
export class HandoverShiftDto extends CloseShiftDto {
  @IsUUID() handToUserId: string;
}

/** No-sale drawer open: the reason is required */
export class DrawerOpenDto {
  @IsString() @MinLength(2) @MaxLength(500) reason: string;
  @IsString() @MaxLength(100) @IsOptional() idempotencyKey?: string;
}

export class CreateShiftCorrectionDto {
  @IsIn(Object.values(ShiftCorrectionType)) type: ShiftCorrectionType;
  // Signed: + raises, − lowers the corrected expected / counted cash
  @IsNumber() @Min(-1_000_000_000) @Max(1_000_000_000) amount: number;
  @IsString() @MinLength(2) @MaxLength(500) reason: string;
}

export class ListDrawersQueryDto {
  @IsUUID() @IsOptional() registerId?: string;
}

export class CreateDrawerDto {
  @IsUUID() registerId: string;
  @IsString() @MinLength(1) @MaxLength(50) code: string;
  @IsString() @MinLength(1) @MaxLength(100) name: string;
}

export class UpdateDrawerDto {
  @IsString() @MinLength(1) @MaxLength(100) @IsOptional() name?: string;
  @IsIn(Object.values(DrawerStatus)) @IsOptional() status?: DrawerStatus;
}
