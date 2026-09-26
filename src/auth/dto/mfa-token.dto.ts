import { IsNotEmpty, IsString, Length } from 'class-validator';

export class MfaTokenDto {
  @IsString()
  @IsNotEmpty()
  @Length(6, 6)
  token: string;
}
