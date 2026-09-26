import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import {
  IsLocalizedText,
  MAX_NAME_LENGTH,
  MAX_DESCRIPTION_LENGTH,
} from '../common/validation/localized-text';

export class CreateCategoryDto {
  @IsString() @IsNotEmpty() @MaxLength(50) code: string;
  @IsLocalizedText({ maxLength: MAX_NAME_LENGTH, requireOne: true })
  name: Record<string, string>;
  @IsLocalizedText({ maxLength: MAX_DESCRIPTION_LENGTH })
  @IsOptional()
  description?: Record<string, string> | null;
  @IsUUID() @IsOptional() parentId?: string | null;
  @IsInt() @Min(0) @IsOptional() sortOrder?: number;
  @IsString() @IsOptional() @MaxLength(255) imageUrl?: string | null;
}

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {
  @IsBoolean() @IsOptional() isActive?: boolean;
}
