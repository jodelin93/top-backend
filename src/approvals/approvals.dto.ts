import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';

export class RequestApprovalDto {
  // What the approver is authorising, e.g. "sales.void"
  @IsString() @MaxLength(100) permission: string;
  @IsEmail() approverEmail: string;
  @IsString() @MaxLength(128) password: string;
  // Required when the approver has two-factor authentication on
  @IsString() @Length(6, 6) @IsOptional() mfaCode?: string;
  // The request the approval is for, "METHOD /path" (the `action` of the 403);
  // the token is only accepted for that action
  @IsString() @IsNotEmpty() @MaxLength(300) action: string;
}
