import { PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { MAX_UNIT_PRECISION } from '../catalog-rules';

export class CreateUnitDto {
  // pc, kg, l, m
  @IsString() @IsNotEmpty() @MaxLength(20) code: string;
  @IsString() @IsNotEmpty() @MaxLength(100) name: string;
  @IsBoolean() @IsOptional() allowsDecimals?: boolean;
  // Decimal places when allowsDecimals
  @IsInt() @Min(0) @Max(MAX_UNIT_PRECISION) @IsOptional() precision?: number;
}

export class UpdateUnitDto extends PartialType(CreateUnitDto) {
  @IsBoolean() @IsOptional() isActive?: boolean;
}
