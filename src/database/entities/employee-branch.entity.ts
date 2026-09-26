import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Employee } from './employee.entity';
import { Branch } from './branch.entity';

/** Branches an employee works at; at most one is their primary branch */
@Entity('employee_branches')
@Index('uq_employee_branch', ['employeeId', 'branchId'], { unique: true })
@Index('uq_employee_primary_branch', ['employeeId'], {
  unique: true,
  where: '"isPrimary" = true',
})
@Index('IDX_employee_branches_branch', ['tenantId', 'branchId'])
export class EmployeeBranch extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  employeeId: string;

  @Column({ type: 'uuid', nullable: false })
  branchId: string;

  @Column({ type: 'boolean', nullable: false, default: false })
  isPrimary: boolean;

  @ManyToOne(() => Employee, (e) => e.branches, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'employeeId',
    foreignKeyConstraintName: 'FK_employee_branches_employee',
  })
  employee?: Employee;

  @ManyToOne(() => Branch, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'branchId',
    foreignKeyConstraintName: 'FK_employee_branches_branch',
  })
  branch?: Branch;
}
