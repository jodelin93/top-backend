import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export class AddBarcodeDto {
  @IsString() @IsNotEmpty() @MaxLength(100) barcode: string;
}

export class UploadImageDto {
  @IsString() @IsOptional() @MaxLength(255) altText?: string;
}

export class UpdateImageDto {
  @IsString() @IsOptional() @MaxLength(255) altText?: string | null;
  // true makes this the primary image (shown in lists and on the POS)
  @IsBoolean() @IsOptional() isPrimary?: boolean;
}

export class ReorderImagesDto {
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  imageIds: string[];
}
