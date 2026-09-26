import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { branchScope } from '../auth/branch-scope';
import { EmployeesService } from './employees.service';
import {
  AttendanceReportQueryDto,
  ClockDto,
  CloseAttendanceDto,
  CreateEmployeeDto,
  DeactivateEmployeeDto,
  LinkUserDto,
  ListEmployeesQueryDto,
  RecordAttendanceDto,
  SetEmployeeBranchesDto,
  UpdateEmployeeDto,
} from './employees.dto';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Employees')
@ApiBearerAuth('JWT-auth')
@Controller('employees')
export class EmployeesController {
  constructor(private employeesService: EmployeesService) {}

  // ---- POS (the signed-in user's own employee record) ----

  /** GET /employees/me/attendance — linked employee and open clock-in */
  @Get('me/attendance')
  @RequireAnyPermission('pos.sell', 'shifts.operate')
  myAttendance(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return this.employeesService.myAttendance(tenantId, user);
  }

  /** POST /employees/me/clock { action: 'in' | 'out' } */
  @Post('me/clock')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission('pos.sell', 'shifts.operate')
  clock(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ClockDto,
  ) {
    return this.employeesService.clock(tenantId, user, dto);
  }

  // ---- Back office ----

  /** Hours per employee: GET /employees/attendance?from=&to=&employeeId=&branchId= */
  @Get('attendance')
  @RequirePermissions('employees.manage')
  attendanceReport(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: AttendanceReportQueryDto,
  ) {
    return this.employeesService.attendanceReport(
      tenantId,
      query,
      branchScope(user),
    );
  }

  @Post('attendance/:attendanceId/close')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('employees.manage')
  closeAttendance(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('attendanceId', ParseUUIDPipe) attendanceId: string,
    @Body() dto: CloseAttendanceDto,
  ) {
    return this.employeesService.closeAttendance(
      tenantId,
      attendanceId,
      dto,
      branchScope(user),
    );
  }

  @Get()
  @RequirePermissions('employees.manage')
  list(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: ListEmployeesQueryDto,
  ) {
    return this.employeesService.list(tenantId, query, branchScope(user));
  }

  @Post()
  @RequirePermissions('employees.manage')
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateEmployeeDto,
  ) {
    return this.employeesService.create(tenantId, dto, branchScope(user));
  }

  @Get(':id')
  @RequirePermissions('employees.manage')
  findOne(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.employeesService.findOne(tenantId, id, branchScope(user));
  }

  @Patch(':id')
  @RequirePermissions('employees.manage')
  update(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
  ) {
    return this.employeesService.update(tenantId, id, dto, branchScope(user));
  }

  @Put(':id/branches')
  @RequirePermissions('employees.manage')
  assignBranches(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetEmployeeBranchesDto,
  ) {
    return this.employeesService.assignBranches(
      tenantId,
      id,
      dto.branches,
      branchScope(user),
    );
  }

  @Post(':id/link-user')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('employees.manage')
  linkUser(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkUserDto,
  ) {
    return this.employeesService.linkUser(
      tenantId,
      id,
      dto.userId,
      branchScope(user),
    );
  }

  @Post(':id/unlink-user')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('employees.manage')
  unlinkUser(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.employeesService.unlinkUser(tenantId, id, branchScope(user));
  }

  /** Deactivate; a linked login is suspended and signed out (needs users.manage too) */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('employees.manage')
  deactivate(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeactivateEmployeeDto,
  ) {
    return this.employeesService.deactivate(tenantId, user, id, dto);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('employees.manage')
  reactivate(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.employeesService.reactivate(tenantId, id, branchScope(user));
  }

  /** Admin: record a worked period (forgotten clock-in, paper timesheet) */
  @Post(':id/attendance')
  @RequirePermissions('employees.manage')
  recordAttendance(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordAttendanceDto,
  ) {
    return this.employeesService.recordAttendance(tenantId, user, id, dto);
  }
}
