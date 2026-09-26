import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Employee } from '../database/entities/employee.entity';
import { EmployeeBranch } from '../database/entities/employee-branch.entity';
import { EmployeeAttendance } from '../database/entities/employee-attendance.entity';
import { UsersModule } from '../users/users.module';
import { EmployeesService } from './employees.service';
import { EmployeesController } from './employees.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Employee, EmployeeBranch, EmployeeAttendance]),
    UsersModule,
  ],
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
