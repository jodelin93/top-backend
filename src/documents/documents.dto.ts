import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  DOCUMENT_TYPES,
  PRINT_JOB_STATUSES,
  type DocumentType,
  type PrintChannel,
  type PrintJobStatus,
} from './print-job.entity';

export class CreatePrintJobDto {
  @ApiProperty({ enum: DOCUMENT_TYPES })
  @IsIn(DOCUMENT_TYPES)
  documentType: DocumentType;

  @ApiProperty()
  @IsUUID()
  documentId: string;

  // Ask for a copy. An original asked for while one is already printed becomes a copy.
  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  copy?: boolean;

  @ApiPropertyOptional({ enum: ['bridge', 'browser'] })
  @IsIn(['bridge', 'browser'])
  @IsOptional()
  channel?: PrintChannel;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(100)
  @IsOptional()
  printerId?: string;
}

export class UpdatePrintJobDto {
  @ApiProperty({ enum: PRINT_JOB_STATUSES })
  @IsIn(PRINT_JOB_STATUSES)
  status: PrintJobStatus;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  error?: string;
}

export class ListPrintJobsQueryDto {
  @ApiProperty({ enum: DOCUMENT_TYPES })
  @IsIn(DOCUMENT_TYPES)
  documentType: DocumentType;

  @ApiProperty()
  @IsUUID()
  documentId: string;
}

export class EmailReceiptDto {
  @ApiProperty()
  @IsEmail()
  @MaxLength(255)
  to: string;

  // The cashier confirmed the customer asked for this receipt by e-mail. Needed
  // unless the address is the customer's own with recorded e-mail consent.
  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  consentConfirmed?: boolean;

  @ApiPropertyOptional({ enum: ['receipt', 'invoice'] })
  @IsIn(['receipt', 'invoice'])
  @IsOptional()
  documentType?: 'receipt' | 'invoice';
}

export class ShareLinkDto {
  // 1–90 days (default 30)
  @ApiPropertyOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  @IsOptional()
  expiresInDays?: number;

  // Phone number the link is sent to, kept (masked in logs) for the history
  @ApiPropertyOptional()
  @IsString()
  @MaxLength(40)
  @IsOptional()
  recipient?: string;
}
