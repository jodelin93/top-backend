import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class SignupDto {
  @IsString() @IsNotEmpty() @MinLength(2) @MaxLength(255) storeName: string;

  // Store address/handle; generated from the name when omitted
  @IsOptional()
  @Matches(/^[a-z0-9](?:[a-z0-9-]{1,48}[a-z0-9])$/, {
    message:
      'slug must be 3-50 lowercase letters, digits or dashes, not starting or ending with a dash',
  })
  slug?: string;

  @IsEmail() @MaxLength(255) email: string;

  // For an existing account: its current password
  @IsString() @MinLength(8) @MaxLength(128) password: string;

  // For an existing account with two-factor on: a current code
  @IsString() @IsOptional() @Length(6, 6) mfaCode?: string;

  @IsString() @IsOptional() @MaxLength(100) firstName?: string;
  @IsString() @IsOptional() @MaxLength(100) lastName?: string;

  @IsString() @IsOptional() @Length(3, 3) currencyCode?: string;
}
