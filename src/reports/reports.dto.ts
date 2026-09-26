import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'timeZone' })
class IsTimeZone implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (typeof value !== 'string') {
      return false;
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }

  defaultMessage() {
    return 'timezone must be a valid IANA time zone';
  }
}

export class ReportQueryDto {
  @IsDateString() from: string;
  @IsDateString() to: string;
  // Used to group sales by local calendar day, e.g. America/New_York
  @IsString()
  @MaxLength(64)
  @Validate(IsTimeZone)
  @IsOptional()
  timezone?: string;
  // Only this branch (default: every branch the user may see)
  @IsUUID() @IsOptional() branchId?: string;
}

// Tabular reports: snapshot reports (stock) don't need a date range
export class RunReportQueryDto {
  @IsDateString() @IsOptional() from?: string;
  @IsDateString() @IsOptional() to?: string;
  @IsString()
  @MaxLength(64)
  @Validate(IsTimeZone)
  @IsOptional()
  timezone?: string;
  // Only this branch (default: every branch the user may see)
  @IsUUID() @IsOptional() branchId?: string;
  // Report parameters (see ReportDefinition.parameters)
  @IsUUID() @IsOptional() variantId?: string;
  @IsUUID() @IsOptional() locationId?: string;
}

export const EXPORT_FORMATS = ['csv', 'xlsx', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export class ExportReportQueryDto extends RunReportQueryDto {
  @IsIn(EXPORT_FORMATS) format: ExportFormat;
}

// Printable end-of-day summary for the whole store (or one branch)
export class DailySummaryQueryDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date: string;
  @IsString()
  @MaxLength(64)
  @Validate(IsTimeZone)
  @IsOptional()
  timezone?: string;
  @IsUUID() @IsOptional() branchId?: string;
}
