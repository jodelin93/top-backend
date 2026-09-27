import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { IsOnOrAfterField } from '../common/validation/date-rules';

export class AuditQueryDto {
  // Prefix match, e.g. "sale." for every sale event
  @IsString() @MaxLength(100) @IsOptional() action?: string;
  @IsString() @MaxLength(50) @IsOptional() entityType?: string;
  @IsString() @MaxLength(100) @IsOptional() entityId?: string;
  @IsUUID() @IsOptional() actorId?: string;
  @IsDateString() @IsOptional() from?: string;
  @IsDateString() @IsOnOrAfterField('from') @IsOptional() to?: string;
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(200) @IsOptional() limit?: number;
}
