import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { PartialType } from '@nestjs/swagger';
import { AttributeType } from '../database/entities/attribute-definition.entity';

export class CreateAttributeDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[A-Za-z0-9_.-]+$/, {
    message: 'code may only contain letters, digits, _ . and -',
  })
  code: string;

  @IsObject() name: Record<string, string>;
  @IsEnum(AttributeType) @IsOptional() attributeType?: AttributeType;

  // Allowed values (select / colour attributes), e.g. ["S", "M", "L"]
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsOptional()
  options?: string[] | null;

  @IsBoolean() @IsOptional() isRequired?: boolean;
  // Variants are generated from variant-defining attributes only
  @IsBoolean() @IsOptional() isVariantDefining?: boolean;
  @IsInt() @Min(0) @IsOptional() sortOrder?: number;
}

export class UpdateAttributeDto extends PartialType(CreateAttributeDto) {}
