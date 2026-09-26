import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';

export class CreateTaxCategoryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[A-Za-z0-9_.-]+$/, {
    message: 'code may only contain letters, digits, _ . and -',
  })
  code: string;

  @IsObject() name: Record<string, string>;
  @IsString() @IsOptional() @MaxLength(255) description?: string | null;
  // null / omitted: products in this category are tax exempt
  @IsUUID() @IsOptional() taxRateId?: string | null;
}

export class UpdateTaxCategoryDto extends PartialType(CreateTaxCategoryDto) {}
