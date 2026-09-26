import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  EXPORT_FORMATS,
  RunReportQueryDto,
  type ExportFormat,
} from '../reports/reports.dto';

export class CreateExportDto {
  @IsString() @IsNotEmpty() @MaxLength(100) reportKey: string;
  @IsIn(EXPORT_FORMATS) format: ExportFormat;
  // Same parameters as GET /reports/:key (from, to, timezone, branchId, …)
  @ValidateNested()
  @Type(() => RunReportQueryDto)
  @IsOptional()
  params?: RunReportQueryDto;
}

/**
 * Saved parameters: a relative date preset ('7d', 'month'…) is kept rather than
 * fixed dates, so a saved "last 7 days" stays the last 7 days.
 */
export class SavedFilterParamsDto extends RunReportQueryDto {
  @IsIn(['today', 'yesterday', '7d', '30d', 'month', 'all', 'custom'])
  @IsOptional()
  preset?: string;
}

export class SaveReportFilterDto {
  @IsString() @IsNotEmpty() @MaxLength(100) reportKey: string;
  @IsString() @IsNotEmpty() @MaxLength(100) name: string;
  // Report parameters to re-apply (date preset, branch, item…)
  @ValidateNested()
  @Type(() => SavedFilterParamsDto)
  params: SavedFilterParamsDto;
  // Visible to everyone who can view reports
  @IsBoolean() @IsOptional() shared?: boolean;
}

export class ListSavedFiltersQueryDto {
  @IsString() @IsOptional() @MaxLength(100) reportKey?: string;
}
