import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
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
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsQuantity } from '../common/dto/quantity.decorator';
import { AdjustmentReason } from '../database/entities/stock-adjustment.entity';
import { ReservationStatus } from '../database/entities/stock-reservation.entity';
import { StockCountStatus } from '../database/entities/stock-count.entity';
import { StockTransferStatus } from '../database/entities/stock-transfer.entity';

export class StockQueryDto {
  @IsString() @IsOptional() @MaxLength(100) search?: string;
  @IsUUID() @IsOptional() locationId?: string;
  // Only rows at or below the store's low-stock threshold
  // (explicit transform: implicit conversion would turn "false" into true)
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  lowStock?: boolean;
  // Only sellable locations (what can be sold; not quarantine / damaged)
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  sellableOnly?: boolean;
}

export class AdjustmentItemDto {
  @IsUUID() variantId: string;
  // mode=set: the counted quantity; mode=delta: amount to add (negative removes).
  // Decimals only for measured items (units that allow them)
  @IsQuantity({ signed: true }) quantity: number;
}

export class CreateAdjustmentDto {
  @IsUUID() locationId: string;
  @IsEnum(AdjustmentReason) reason: AdjustmentReason;
  @IsIn(['set', 'delta']) mode: 'set' | 'delta';
  @IsString() @IsOptional() @MaxLength(500) notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => AdjustmentItemDto)
  items: AdjustmentItemDto[];
}

export class ReceiveItemDto {
  @IsUUID() variantId: string;
  @IsQuantity() quantity: number;
  @IsNumber() @Min(0) @IsOptional() cost?: number;
  // Damaged goods go to the warehouse's quarantine / damaged location when there is one
  @IsIn(['good', 'damaged']) @IsOptional() condition?: 'good' | 'damaged';
}

export class ReceiveStockDto {
  @IsUUID() locationId: string;
  // Supplier invoice / delivery note number
  @IsString() @IsOptional() @MaxLength(100) reference?: string;
  @IsString() @IsOptional() @MaxLength(500) notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceiveItemDto)
  items: ReceiveItemDto[];
}

export class MovementsQueryDto {
  @IsUUID() @IsOptional() variantId?: string;
  @IsUUID() @IsOptional() locationId?: string;
  @IsInt() @Min(1) @IsOptional() limit?: number;
}

// ---- Reservations ----

export class ReservationsQueryDto {
  @IsEnum(ReservationStatus) @IsOptional() status?: ReservationStatus;
  @IsUUID() @IsOptional() variantId?: string;
  @IsUUID() @IsOptional() locationId?: string;
}

// ---- Stock counts ----

export class CreateStockCountDto {
  @IsUUID() locationId: string;
  // Count only this category (and its sub-categories)
  @IsUUID() @IsOptional() categoryId?: string;
  // Or only these variants
  @IsArray()
  @IsOptional()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @IsUUID('all', { each: true })
  variantIds?: string[];
  // Hide expected quantities while counting
  @IsBoolean() @IsOptional() blind?: boolean;
  @IsString() @IsOptional() @MaxLength(500) notes?: string;
}

export class CountEntryDto {
  @IsUUID() variantId: string;
  // null clears the entry (line not counted)
  @ValidateIf((_, v) => v !== null)
  @IsQuantity({ min: 0 })
  countedQuantity: number | null;
  // Why it differs (damaged, found in the back…); omit to keep, null to clear
  @IsString() @IsOptional() @MaxLength(200) reason?: string | null;
}

export class EnterCountsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5000)
  @ValidateNested({ each: true })
  @Type(() => CountEntryDto)
  items: CountEntryDto[];
}

export class StockCountsQueryDto {
  @IsEnum(StockCountStatus) @IsOptional() status?: StockCountStatus;
  @IsUUID() @IsOptional() locationId?: string;
}

export class InventoryReasonDto {
  @IsString() @IsOptional() @MaxLength(500) reason?: string;
}

// ---- Transfers ----

export class TransferItemInputDto {
  @IsUUID() variantId: string;
  @IsQuantity() quantity: number;
}

export class SaveTransferDto {
  @IsUUID() fromLocationId: string;
  @IsUUID() toLocationId: string;
  @IsString() @IsOptional() @MaxLength(500) notes?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TransferItemInputDto)
  items: TransferItemInputDto[];
}

export class TransferLineDto {
  @IsUUID() itemId: string;
  @IsQuantity({ min: 0 }) quantity: number;
}

export class TransferQuantitiesDto {
  // Omit to dispatch / receive / write off everything still possible
  @IsArray()
  @IsOptional()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TransferLineDto)
  items?: TransferLineDto[];

  @IsString() @IsOptional() @MaxLength(500) notes?: string;

  // Retrying with the same key returns the transfer without posting twice
  @IsString() @IsOptional() @MaxLength(100) idempotencyKey?: string;
}

export class TransferDispatchDto extends TransferQuantitiesDto {
  // Last dispatch: what was requested but not sent is dropped
  @IsBoolean() @IsOptional() complete?: boolean;
}

export class TransferReceiptLineDto {
  @IsUUID() itemId: string;
  // Arrived in good condition
  @IsQuantity({ min: 0 }) quantity: number;
  // Arrived damaged
  @IsQuantity({ min: 0 }) @IsOptional() damaged?: number;
  // Reported missing (stays in transit until found or written off)
  @IsQuantity({ min: 0 }) @IsOptional() missing?: number;
}

export class TransferReceiveDto {
  // Omit to receive everything still in transit in good condition
  @IsArray()
  @IsOptional()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => TransferReceiptLineDto)
  items?: TransferReceiptLineDto[];

  @IsString() @IsOptional() @MaxLength(500) notes?: string;
  @IsString() @IsOptional() @MaxLength(100) idempotencyKey?: string;
}

export class TransfersQueryDto {
  @IsEnum(StockTransferStatus) @IsOptional() status?: StockTransferStatus;
  @IsUUID() @IsOptional() locationId?: string;
}

// ---- Valuation ----

export class RevalueCostDto {
  @IsUUID() variantId: string;
  @IsNumber() @Min(0) @Max(1e12) newCost: number;
  @IsString() @IsNotEmpty() @MaxLength(500) reason: string;
}

export class ChangeCostingMethodDto {
  @IsIn(['average', 'fifo']) method: 'average' | 'fifo';
  @IsString() @IsNotEmpty() @MaxLength(500) reason: string;
}

// ---- Aging ----

export class AgingQueryDto {
  @IsUUID() @IsOptional() locationId?: string;
  @IsString() @IsOptional() @MaxLength(100) search?: string;
  // Only lines at least this many days old
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @IsOptional()
  minDays?: number;
}

// ---- Projection rebuild ----

export class RebuildStockDto {
  // Omit for the whole store
  @IsUUID() @IsOptional() locationId?: string;
}
