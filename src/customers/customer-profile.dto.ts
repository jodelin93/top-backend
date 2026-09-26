import { PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { CustomerAddressType } from '../database/entities/customer-address.entity';
import { CustomerNoteVisibility } from '../database/entities/customer-note.entity';

export class CreateCustomerAddressDto {
  @IsEnum(CustomerAddressType) addressType: CustomerAddressType;
  @IsString() @IsOptional() @MaxLength(100) label?: string | null;
  @IsString() @IsNotEmpty() @MaxLength(255) line1: string;
  @IsString() @IsOptional() @MaxLength(255) line2?: string | null;
  @IsString() @IsOptional() @MaxLength(100) city?: string | null;
  @IsString() @IsOptional() @MaxLength(100) state?: string | null;
  @IsString() @IsOptional() @MaxLength(20) postalCode?: string | null;
  @IsString() @IsOptional() @MaxLength(100) country?: string | null;
  // Becomes the default of its type (the previous default is unset)
  @IsBoolean() @IsOptional() isDefault?: boolean;
}

export class UpdateCustomerAddressDto extends PartialType(
  CreateCustomerAddressDto,
) {}

export class CreateCustomerContactDto {
  @IsString() @IsNotEmpty() @MaxLength(255) name: string;
  @IsString() @IsOptional() @MaxLength(100) role?: string | null;
  @IsEmail() @IsOptional() @MaxLength(255) email?: string | null;
  @IsString() @IsOptional() @MaxLength(50) phone?: string | null;
  @IsBoolean() @IsOptional() isPrimary?: boolean;
}

export class UpdateCustomerContactDto extends PartialType(
  CreateCustomerContactDto,
) {}

export class CreateCustomerNoteDto {
  @IsString() @IsNotEmpty() @MaxLength(5000) body: string;
  // 'managers': only users with customers.manage see it
  @IsEnum(CustomerNoteVisibility)
  @IsOptional()
  visibility?: CustomerNoteVisibility;
}
