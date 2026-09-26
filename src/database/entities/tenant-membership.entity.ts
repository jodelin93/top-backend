import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { User } from './user.entity';

export enum MembershipStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  // An existing account was added: no access until its owner accepts
  INVITED = 'invited',
}

// Keys of the built-in roles every store has; stores can add custom roles
export enum MembershipRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  MANAGER = 'manager',
  CASHIER = 'cashier',
}

@Entity('tenant_memberships')
@Unique('uq_tenant_user', ['tenantId', 'userId'])
@Index(['tenantId'])
@Index(['userId'])
export class TenantMembership extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @Column({
    type: 'enum',
    enum: MembershipStatus,
    default: MembershipStatus.ACTIVE,
    nullable: false,
  })
  status: MembershipStatus;

  // Key of a tenant_roles row (built-in keys are listed in MembershipRole)
  @Column({
    type: 'varchar',
    length: 50,
    default: MembershipRole.CASHIER,
    nullable: false,
  })
  role: string;

  @Column({
    type: 'timestamptz',
    default: () => 'CURRENT_TIMESTAMP',
    nullable: false,
  })
  joinedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  leftAt: Date;

  /**
   * Branches the member works in (spec §3/§9): null = every branch (the default;
   * owners always have every branch). Resolved on each request (JwtStrategy).
   */
  @Column({ type: 'uuid', array: true, nullable: true })
  branchIds: string[] | null;

  // Relations
  @ManyToOne(() => Tenant, (tenant) => tenant.users, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => User, (user) => user.tenants, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: User;
}
