import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { OmitType, PartialType } from '@nestjs/swagger';
import { CustomerFieldType } from '../database/entities/customer-field-definition.entity';

export class CreateCustomerGroupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[A-Za-z0-9_.-]+$/, {
    message: 'code may only contain letters, digits, _ . and -',
  })
  code: string;

  @IsString() @IsNotEmpty() @MaxLength(100) name: string;
  @IsString() @IsOptional() @MaxLength(255) description?: string | null;
  // Default price list for the group's customers (stored; applied by the POS later)
  @IsUUID() @IsOptional() priceListId?: string | null;
  @IsNumber() @Min(0) @Max(100) @IsOptional() discountPercent?: number;
  @IsBoolean() @IsOptional() isActive?: boolean;
  // Payment terms (days) for members' sales on account, unless set on the customer
  @IsInt() @Min(0) @Max(3650) @IsOptional() defaultPaymentTermDays?:
    number | null;
}

export class UpdateCustomerGroupDto extends PartialType(
  CreateCustomerGroupDto,
) {}

export class CreateCustomerFieldDto {
  // Key under which the value is stored, e.g. "loyalty_card"
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{0,49}$/, {
    message:
      'key must start with a letter and contain only lowercase letters, digits and _',
  })
  key: string;

  @IsString() @IsNotEmpty() @MaxLength(100) label: string;
  @IsEnum(CustomerFieldType) fieldType: CustomerFieldType;
  @IsBoolean() @IsOptional() isRequired?: boolean;

  // Choices of a select field
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsOptional()
  options?: string[] | null;

  @IsInt() @Min(0) @IsOptional() sortOrder?: number;
  @IsBoolean() @IsOptional() isActive?: boolean;
}

// The key can't change once values are stored under it
export class UpdateCustomerFieldDto extends PartialType(
  OmitType(CreateCustomerFieldDto, ['key'] as const),
) {}
