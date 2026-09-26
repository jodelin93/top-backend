import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_LABEL_COPIES } from '../catalog-rules';

export class LabelRequestDto {
  @IsUUID() variantId: string;
  @IsInt() @Min(1) @Max(MAX_LABEL_COPIES) copies: number;
}

/** POST /products/labels */
export class PrintLabelsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => LabelRequestDto)
  items: LabelRequestDto[];

  // Language of the product names printed
  @IsIn(['en', 'fr', 'ht', 'es']) @IsOptional() language?: string;
}
