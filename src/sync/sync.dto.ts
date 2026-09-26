import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class SyncChangesQueryDto {
  // Cursor from the previous response; omit on the first sync
  @IsString() @IsOptional() @MaxLength(2000) cursor?: string;
  // Register whose stock location / branch assortment the catalog is for
  @IsUUID() @IsOptional() registerId?: string;
  @IsInt() @Min(1) @Max(2000) @IsOptional() limit?: number;
}

// Operations one push may carry
export const MAX_PUSH_OPERATIONS = 100;
// Payload schema versions this server understands
export const SUPPORTED_SCHEMA_VERSION = 1;
export const SYNC_OPERATION_TYPES = ['sale.create'] as const;
export type SyncOperationType = (typeof SYNC_OPERATION_TYPES)[number];

/** Typed envelope of one operation recorded on a till (spec §19). */
export class SyncOperationDto {
  // Client-generated id, stable across retries (for sales: the idempotency key)
  @IsString() @IsNotEmpty() @MaxLength(100) deviceOperationId: string;
  // Per-device order; operations are applied in this order
  @IsInt() @Min(0) deviceSequence: number;
  @IsIn(SYNC_OPERATION_TYPES) type: SyncOperationType;
  @IsInt() @Min(1) schemaVersion: number;
  // sha256 (hex) of the canonical JSON of `payload`
  @IsString() @Length(64, 64) payloadHash: string;
  // sale.create: a POST /sales body (validated per operation)
  @IsObject() payload: Record<string, unknown>;
  // Signed offline lease the operation was captured under
  @IsString() @IsOptional() @MaxLength(4000) lease?: string;
  // Cashier who recorded it on the till
  @IsUUID() @IsOptional() actorId?: string;
  // Capture time on the till's clock
  @IsDateString() @IsOptional() capturedAt?: string;
  // Operations that must be applied first
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @IsOptional()
  dependsOn?: string[];
  // Pricing / policy snapshot the till used (kept for review)
  @IsObject() @IsOptional() snapshot?: Record<string, unknown>;
}

export class SyncPushDto {
  // Till that recorded the operations (required for an import)
  @IsUUID() @IsOptional() deviceId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PUSH_OPERATIONS)
  @ValidateNested({ each: true })
  @Type(() => SyncOperationDto)
  operations: SyncOperationDto[];
}

/** Operations exported from a dead till, uploaded by an administrator. */
export class SyncImportDto {
  @IsUUID() deviceId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PUSH_OPERATIONS)
  @ValidateNested({ each: true })
  @Type(() => SyncOperationDto)
  operations: SyncOperationDto[];
}

export class SyncExportApprovalDto {
  @IsUUID() @IsOptional() deviceId?: string;
  // Number of operations in the file (for the audit log)
  @IsInt() @Min(0) @IsOptional() operations?: number;
}
