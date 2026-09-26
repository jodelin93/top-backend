import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';
import { BaseEntityWithVersion } from './base.entity';
import { Tenant } from './tenant.entity';
import { User } from './user.entity';
import { EmployeeBranch } from './employee-branch.entity';

export enum EmployeeStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * A person working for the store (HR record), separate from login identities:
 * not every employee signs in, and an account (users) may be linked to at most
 * one employee of the store.
 */
@Entity('employees')
@Index('IDX_employees_tenant_status', ['tenantId', 'status'])
@Index('uq_employee_code', ['tenantId', 'employeeCode'], {
  unique: true,
  where: '"employeeCode" IS NOT NULL',
})
@Index('uq_employee_user', ['tenantId', 'userId'], {
  unique: true,
  where: '"userId" IS NOT NULL',
})
@Check('CHK_employees_status', `"status" IN ('active', 'inactive')`)
export class Employee extends BaseEntityWithVersion {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  // Optional link to a login (a member of the store)
  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'varchar', length: 100, nullable: false })
  firstName: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  lastName: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  jobTitle: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  employeeCode: string | null;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: false,
    default: EmployeeStatus.ACTIVE,
  })
  status: EmployeeStatus;

  @Column({ type: 'date', nullable: true })
  hireDate: string | null;

  @Column({ type: 'date', nullable: true })
  terminationDate: string | null;

  @Column({ type: 'varchar', length: 2000, nullable: true })
  notes: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_employees_tenant',
  })
  tenant?: Tenant;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'FK_employees_user',
  })
  user?: User | null;

  @OneToMany(() => EmployeeBranch, (b) => b.employee)
  branches?: EmployeeBranch[];
}
