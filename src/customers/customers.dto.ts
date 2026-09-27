import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import {
  CustomerStatus,
  CustomerType,
} from '../database/entities/customer.entity';
import { MERGE_CHOICE_FIELDS } from './customer-merge';
import {
  IsNotBeforeDay,
  IsNotFutureDate,
} from '../common/validation/date-rules';

export class CreateCustomerDto {
  // Generated (CUST-000001) when omitted
  @IsString() @IsOptional() @MaxLength(50) code?: string;
  @IsEnum(CustomerType) @IsOptional() customerType?: CustomerType;
  @IsString() @IsOptional() @MaxLength(255) firstName?: string | null;
  @IsString() @IsOptional() @MaxLength(255) lastName?: string | null;
  @IsString() @IsOptional() @MaxLength(255) companyName?: string | null;
  @IsEmail() @IsOptional() @MaxLength(255) email?: string | null;
  @IsString() @IsOptional() @MaxLength(50) phone?: string | null;
  @IsString() @IsOptional() @MaxLength(100) taxNumber?: string | null;
  @IsDateString()
  @IsNotFutureDate()
  @IsNotBeforeDay('1900-01-01')
  @IsOptional()
  dateOfBirth?: string | null;
  @IsNumber() @Min(0) @IsOptional() creditLimit?: number;
  // Days to pay a charge on account (null: the group's terms, else 30)
  @IsInt() @Min(0) @Max(3650) @IsOptional() paymentTermDays?: number | null;
  // No new sales on account while set
  @IsBoolean() @IsOptional() creditHold?: boolean;
  @IsUUID() @IsOptional() groupId?: string | null;

  // Marketing consent; changes are recorded in the consent history
  @IsBoolean() @IsOptional() marketingEmailConsent?: boolean;
  @IsBoolean() @IsOptional() marketingSmsConsent?: boolean;
  // Where consent was given, e.g. pos, admin, web, paper form (default: admin)
  @IsString() @IsOptional() @MaxLength(50) consentSource?: string;

  // Values of the store's custom customer fields, by key.
  // When sent, required fields are enforced.
  @IsObject() @IsOptional() customFields?: Record<string, unknown>;
}

export class UpdateCustomerDto extends PartialType(CreateCustomerDto) {
  @IsEnum(CustomerStatus) @IsOptional() status?: CustomerStatus;
}

export class ListCustomersQueryDto {
  @IsString() @IsOptional() @MaxLength(100) search?: string;
  @IsEnum(CustomerStatus) @IsOptional() status?: CustomerStatus;
  @IsUUID() @IsOptional() groupId?: string;
  // Merged (retired) records are hidden unless asked for
  @IsIn(['true', 'false']) @IsOptional() includeMerged?: 'true' | 'false';
}

export class DuplicateCheckQueryDto {
  @IsString() @IsOptional() @MaxLength(255) email?: string;
  @IsString() @IsOptional() @MaxLength(50) phone?: string;
  @IsString() @IsOptional() @MaxLength(255) firstName?: string;
  @IsString() @IsOptional() @MaxLength(255) lastName?: string;
  @IsUUID() @IsOptional() excludeId?: string;
}

export class DuplicatesQueryDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(200) @IsOptional() limit?: number;
}

type Choice = 'survivor' | 'merged';

export class MergeChoicesDto implements Partial<
  Record<(typeof MERGE_CHOICE_FIELDS)[number], Choice>
> {
  @IsIn(['survivor', 'merged']) @IsOptional() customerType?: Choice;
  @IsIn(['survivor', 'merged']) @IsOptional() firstName?: Choice;
  @IsIn(['survivor', 'merged']) @IsOptional() lastName?: Choice;
  @IsIn(['survivor', 'merged']) @IsOptional() companyName?: Choice;
  @IsIn(['survivor', 'merged']) @IsOptional() email?: Choice;
  @IsIn(['survivor', 'merged']) @IsOptional() phone?: Choice;
  @IsIn(['survivor', 'merged']) @IsOptional() taxNumber?: Choice;
  @IsIn(['survivor', 'merged']) @IsOptional() dateOfBirth?: Choice;
  @IsIn(['survivor', 'merged']) @IsOptional() locale?: Choice;
  @IsIn(['survivor', 'merged']) @IsOptional() groupId?: Choice;
  @IsIn(['survivor', 'merged']) @IsOptional() creditLimit?: Choice;
}

/** POST /customers/merge */
export class MergeCustomersDto {
  // Record that is kept
  @IsUUID() survivorId: string;
  // Duplicate that is retired into the survivor
  @IsUUID() mergedId: string;

  // Which record each field is taken from (default: survivor, or merged when the survivor's is empty)
  @ValidateNested()
  @Type(() => MergeChoicesDto)
  @IsOptional()
  choices?: MergeChoicesDto;
}
