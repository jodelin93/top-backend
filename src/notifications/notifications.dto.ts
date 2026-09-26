import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

export class ListNotificationsQueryDto {
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  @IsOptional()
  unreadOnly?: boolean;

  @IsString() @MaxLength(100) @IsOptional() type?: string;
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}

export class UpdateNotificationPreferencesDto {
  @IsBoolean() @IsOptional() inApp?: boolean;
  @IsBoolean() @IsOptional() email?: boolean;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  @IsOptional()
  mutedTypes?: string[];

  // "HH:MM", or null to turn quiet hours off
  @ValidateIf((_, value) => value !== null)
  @Matches(TIME_OF_DAY, { message: 'quietHoursStart must be HH:MM' })
  @IsOptional()
  quietHoursStart?: string | null;

  @ValidateIf((_, value) => value !== null)
  @Matches(TIME_OF_DAY, { message: 'quietHoursEnd must be HH:MM' })
  @IsOptional()
  quietHoursEnd?: string | null;

  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  @IsOptional()
  timezone?: string | null;
}
