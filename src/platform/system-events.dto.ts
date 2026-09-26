import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class OutboxQueryDto {
  @IsIn(['pending', 'failed', 'dead', 'published', 'all'])
  @IsOptional()
  status?: 'pending' | 'failed' | 'dead' | 'published' | 'all';

  @IsString() @MaxLength(100) @IsOptional() eventType?: string;
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(200) @IsOptional() limit?: number;
}

export class ReplayEventDto {
  // Only this consumer (default: every consumer of the event)
  @Matches(/^[a-z0-9][a-z0-9._-]{0,99}$/)
  @IsOptional()
  consumer?: string;
}

export class CheckRunsQueryDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}

export class BackupReportDto {
  @IsIn(['succeeded', 'failed'])
  status: 'succeeded' | 'failed';

  // Short reason (never file contents or credentials)
  @IsString() @MaxLength(500) @IsOptional() message?: string;
  @IsString() @MaxLength(255) @IsOptional() file?: string;
}
