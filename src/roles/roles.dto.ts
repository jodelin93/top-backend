import {
  ArrayUnique,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class CreateRoleDto {
  // Lowercase identifier, e.g. "shift-lead"
  @IsString()
  @Matches(/^[a-z][a-z0-9-]{1,49}$/, {
    message:
      'key must be lowercase letters, digits or dashes (2-50 characters)',
  })
  key: string;

  @IsString() @IsNotEmpty() @MaxLength(100) name: string;
  @IsString() @IsOptional() @MaxLength(255) description?: string | null;

  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions: string[];
}

export class UpdateRoleDto {
  @IsString() @IsNotEmpty() @MaxLength(100) @IsOptional() name?: string;
  @IsString() @IsOptional() @MaxLength(255) description?: string | null;
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  @IsOptional()
  permissions?: string[];
}
