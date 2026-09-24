import { Entity, Column, Index, OneToMany } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Branch } from './branch.entity';
import { User } from './user.entity';

export enum TenantStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DELETED = 'deleted',
}

@Entity('tenants')
@Index(['slug'], { unique: true })
@Index(['status'], { where: "status = 'active'" })
export class Tenant extends BaseEntity {
  @Column({ type: 'varchar', length: 255, nullable: false })
  name: string;

  @Column({ type: 'varchar', length: 100, unique: true, nullable: false })
  slug: string;

  @Column({
    type: 'enum',
    enum: TenantStatus,
    default: TenantStatus.ACTIVE,
    nullable: false,
  })
  status: TenantStatus;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  settings: Record<string, any>;

  // Relations
  @OneToMany(() => Branch, (branch) => branch.tenant)
  branches: Branch[];

  @OneToMany(() => User, (user) => user.tenants)
  users: User[];
}
