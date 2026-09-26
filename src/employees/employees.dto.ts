import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { EmployeeStatus } from '../database/entities/employee.entity';

export class EmployeeBranchInput {
  @IsUUID() branchId: string;
  @IsBoolean() @IsOptional() isPrimary?: boolean;
}

export class CreateEmployeeDto {
  @IsString() @MinLength(1) @MaxLength(100) firstName: string;
  @IsString() @MinLength(1) @MaxLength(100) lastName: string;
  @IsString() @MaxLength(100) @IsOptional() jobTitle?: string;
  @IsString() @MaxLength(50) @IsOptional() phone?: string;
  @IsEmail() @MaxLength(255) @IsOptional() email?: string;
  @IsString() @MaxLength(50) @IsOptional() employeeCode?: string;
  @IsDateString() @IsOptional() hireDate?: string;
  @IsString() @MaxLength(2000) @IsOptional() notes?: string;
  // Optional link to a login (a member of the store)
  @IsUUID() @IsOptional() userId?: string;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => EmployeeBranchInput)
  @IsOptional()
  branches?: EmployeeBranchInput[];
}

export class UpdateEmployeeDto {
  @IsString() @MinLength(1) @MaxLength(100) @IsOptional() firstName?: string;
  @IsString() @MinLength(1) @MaxLength(100) @IsOptional() lastName?: string;
  @IsString() @MaxLength(100) @IsOptional() jobTitle?: string | null;
  @IsString() @MaxLength(50) @IsOptional() phone?: string | null;
  @IsEmail() @MaxLength(255) @IsOptional() email?: string | null;
  @IsString() @MaxLength(50) @IsOptional() employeeCode?: string | null;
  @IsDateString() @IsOptional() hireDate?: string | null;
  @IsString() @MaxLength(2000) @IsOptional() notes?: string | null;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => EmployeeBranchInput)
  @IsOptional()
  branches?: EmployeeBranchInput[];
}

export class SetEmployeeBranchesDto {
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => EmployeeBranchInput)
  branches: EmployeeBranchInput[];
}

export class LinkUserDto {
  @IsUUID() userId: string;
}

export class DeactivateEmployeeDto {
  @IsDateString() @IsOptional() terminationDate?: string;
  @IsString() @MaxLength(500) @IsOptional() reason?: string;
}

export class ListEmployeesQueryDto {
  @IsIn(Object.values(EmployeeStatus)) @IsOptional() status?: EmployeeStatus;
  @IsUUID() @IsOptional() branchId?: string;
  @IsString() @MaxLength(100) @IsOptional() search?: string;
  @Type(() => Number) @IsInt() @Min(1) @IsOptional() page?: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(100) @IsOptional() limit?: number;
}

/** POS: clock the signed-in user's employee in or out */
export class ClockDto {
  @IsIn(['in', 'out']) action: 'in' | 'out';
  @IsUUID() @IsOptional() branchId?: string;
  @IsString() @MaxLength(500) @IsOptional() note?: string;
}

/** Admin: record a clock-in (and out) after the fact */
export class RecordAttendanceDto {
  @IsDateString() clockIn: string;
  @IsDateString() @IsOptional() clockOut?: string;
  @IsUUID() @IsOptional() branchId?: string;
  @IsString() @MinLength(2) @MaxLength(500) note: string;
}

export class CloseAttendanceDto {
  @IsDateString() clockOut: string;
  @IsString() @MaxLength(500) @IsOptional() note?: string;
}

export class AttendanceReportQueryDto {
  @IsDateString() from: string;
  @IsDateString() to: string;
  @IsUUID() @IsOptional() employeeId?: string;
  @IsUUID() @IsOptional() branchId?: string;
}
