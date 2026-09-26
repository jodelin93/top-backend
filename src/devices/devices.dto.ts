import {
  IsDateString,
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

export class RegisterDeviceDto {
  // Id the device already holds (re-registration after a reinstall keeps the row)
  @IsUUID() @IsOptional() deviceId?: string;
  @IsString() @IsOptional() @MaxLength(100) name?: string;
  @IsIn(['pos']) @IsOptional() type?: 'pos';
  @IsUUID() @IsOptional() registerId?: string;
  @IsString() @IsOptional() @MaxLength(50) appVersion?: string;
}

export class HeartbeatDto {
  @IsInt() @Min(0) @Max(1_000_000) pendingSales: number;
  @IsInt() @Min(0) @Max(1_000_000) @IsOptional() failedSales?: number;
  // Highest deviceSequence the device has assigned
  @IsInt() @Min(0) @IsOptional() lastSequence?: number;
  @IsUUID() @IsOptional() registerId?: string;
  // Last time the device finished a sync (queue upload + data refresh)
  @IsDateString() @IsOptional() lastSyncAt?: string;
  @IsString() @IsOptional() @MaxLength(50) appVersion?: string;
  // Sync queue details for the sync dashboard (spec §19)
  @IsDateString() @IsOptional() oldestPendingAt?: string;
  @IsNumber() @Min(0) @IsOptional() pendingAmount?: number;
  @IsInt() @Min(0) @Max(1_000_000_000) @IsOptional() syncRetries?: number;
}

export class LeaseRequestDto {
  // Register the till sells on (binds the lease to its branch)
  @IsUUID() @IsOptional() registerId?: string;
}

export class UpdateDeviceDto {
  @IsString() @IsNotEmpty() @MaxLength(100) @IsOptional() name?: string;
  @IsUUID() @IsOptional() registerId?: string | null;
}

export class RevokeDeviceDto {
  @IsString() @IsOptional() @MaxLength(255) reason?: string;
}

export class DeviceSummaryQueryDto {
  // A device not heard from for this long counts as "not seen recently"
  @IsInt() @Min(1) @Max(10_080) @IsOptional() staleMinutes?: number;
}
