import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_MONEY } from '../../common/validation/money';

export class AttributeSelectionDto {
  @IsUUID() attributeId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  values: string[];
}

/** POST /products/:id/variants/generate */
export class GenerateVariantsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @ValidateNested({ each: true })
  @Type(() => AttributeSelectionDto)
  attributes: AttributeSelectionDto[];

  // Preview only: list the combinations without creating anything
  @IsBoolean() @IsOptional() dryRun?: boolean;

  // Price and cost of the new variants (edit them individually afterwards)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(MAX_MONEY)
  @IsOptional()
  price?: number;
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(MAX_MONEY)
  @IsOptional()
  cost?: number;
}
