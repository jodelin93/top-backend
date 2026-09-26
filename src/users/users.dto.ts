import {
  IsIn,
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { MembershipStatus } from '../database/entities/tenant-membership.entity';

export class CreateMemberDto {
  @IsEmail() @MaxLength(255) email: string;
  @IsString() @IsOptional() @MaxLength(100) firstName?: string;
  @IsString() @IsOptional() @MaxLength(100) lastName?: string;
  // Required when the email doesn't belong to an existing user
  @IsString() @IsOptional() @MinLength(8) @MaxLength(128) password?: string;
  // Key of one of the store's roles (built-in or custom)
  @IsString() @MaxLength(50) role: string;
  // Branches the member works in; null or absent = every branch (spec §9)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  branchIds?: string[] | null;
}

export class UpdateMemberDto {
  @IsString() @IsOptional() @MaxLength(100) firstName?: string;
  @IsString() @IsOptional() @MaxLength(100) lastName?: string;
  @IsString() @MaxLength(50) @IsOptional() role?: string;
  // Admins switch access on and off; an invitation only its invitee accepts
  @IsIn([MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED])
  @IsOptional()
  status?: MembershipStatus;
  // null = every branch; absent = unchanged
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  branchIds?: string[] | null;
}

export class ResetPasswordDto {
  @IsString() @MinLength(8) @MaxLength(128) password: string;
}
