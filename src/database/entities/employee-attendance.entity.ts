import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Employee } from './employee.entity';

export enum AttendanceSource {
  POS = 'pos',
  ADMIN = 'admin',
}

/** A clock-in / clock-out record. clockOut is null while the employee is at work. */
@Entity('employee_attendance')
@Index('IDX_employee_attendance_employee', [
  'tenantId',
  'employeeId',
  'clockIn',
])
@Index('IDX_employee_attendance_tenant', ['tenantId', 'clockIn'])
// At most one open record (clocked in, not out) per employee
@Index('uq_employee_attendance_open', ['employeeId'], {
  unique: true,
  where: '"clockOut" IS NULL',
})
@Check('CHK_employee_attendance_source', `"source" IN ('pos', 'admin')`)
@Check(
  'CHK_employee_attendance_order',
  `"clockOut" IS NULL OR "clockOut" >= "clockIn"`,
)
export class EmployeeAttendance extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  employeeId: string;

  @Column({ type: 'timestamptz', nullable: false })
  clockIn: Date;

  @Column({ type: 'timestamptz', nullable: true })
  clockOut: Date | null;

  @Column({ type: 'uuid', nullable: true })
  branchId: string | null;

  @Column({ type: 'varchar', length: 10, nullable: false })
  source: AttendanceSource;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null;

  // Who recorded it (the employee at the till, or an admin)
  @Column({ type: 'uuid', nullable: true })
  recordedById: string | null;

  @ManyToOne(() => Employee, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'employeeId',
    foreignKeyConstraintName: 'FK_employee_attendance_employee',
  })
  employee?: Employee;
}
