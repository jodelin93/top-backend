import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { RESET_LANGUAGES } from '../password-reset-email';

export class ForgotPasswordDto {
  @IsEmail() @MaxLength(255) email: string;

  // Language of the e-mail (the one shown on the sign-in page)
  @IsOptional() @IsIn([...RESET_LANGUAGES]) language?: string;
}

export class ResetPasswordWithTokenDto {
  // base64url of 32 random bytes
  @IsString() @Matches(/^[A-Za-z0-9_-]{43}$/) token: string;

  @IsString() @MinLength(8) @MaxLength(128) newPassword: string;
}
