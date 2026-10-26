import { IsString, MaxLength } from 'class-validator';

export class EnableMfaDto {
  // A stolen session alone can't put an authenticator on the account
  @IsString() @MaxLength(128) currentPassword: string;
}
