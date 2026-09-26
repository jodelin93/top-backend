import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export class ReportedPrinterDto {
  @ApiProperty()
  @IsString()
  @MaxLength(100)
  id: string;

  @ApiProperty()
  @IsString()
  @MaxLength(100)
  name: string;

  @ApiProperty()
  @IsString()
  @MaxLength(20)
  connection: string;

  @ApiProperty()
  @IsBoolean()
  online: boolean;

  @ApiPropertyOptional({ enum: ['ok', 'low', 'out'], nullable: true })
  @IsIn(['ok', 'low', 'out', null])
  @IsOptional()
  paper: 'ok' | 'low' | 'out' | null;

  @ApiPropertyOptional({ nullable: true })
  @IsBoolean()
  @IsOptional()
  coverOpen: boolean | null;

  @ApiProperty({ enum: [58, 80] })
  @IsIn([58, 80])
  widthMm: 58 | 80;
}

export class ReportHardwareDto {
  @ApiProperty()
  @IsBoolean()
  bridgePaired: boolean;

  @ApiProperty()
  @IsBoolean()
  bridgeReachable: boolean;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(30)
  @IsOptional()
  bridgeVersion?: string;

  @ApiProperty({ type: [ReportedPrinterDto] })
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ReportedPrinterDto)
  printers: ReportedPrinterDto[];

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  customerDisplay?: boolean;
}
