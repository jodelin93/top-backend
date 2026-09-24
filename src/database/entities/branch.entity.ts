import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
  OneToMany,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Register } from './register.entity';

export enum BranchStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

@Entity('branches')
@Unique('uq_branch_code', ['tenantId', 'code'])
@Index(['tenantId'])
@Index(['status'], { where: "status = 'active'" })
export class Branch extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  addressLine1: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  addressLine2: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  stateProvince: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  postalCode: string;

  @Column({ type: 'char', length: 2, nullable: true })
  countryCode: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string;

  @Column({ type: 'varchar', length: 50, default: 'UTC', nullable: false })
  timezone: string;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  taxNumber: string;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  settings: Record<string, any>;

  @Column({
    type: 'enum',
    enum: BranchStatus,
    default: BranchStatus.ACTIVE,
    nullable: false,
  })
  status: BranchStatus;

  // Relations
  @ManyToOne(() => Tenant, (tenant) => tenant.branches, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenant_id' })
  tenant: Tenant;

  @OneToMany(() => Register, (register) => register.branch)
  registers: Register[];
}
