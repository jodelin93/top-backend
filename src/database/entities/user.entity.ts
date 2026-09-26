import { Entity, Column, Index, OneToMany } from 'typeorm';
import { BaseEntity } from './base.entity';
import { TenantMembership } from './tenant-membership.entity';
import { Exclude } from 'class-transformer';

export enum UserStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  DELETED = 'deleted',
}

@Entity('users')
@Index(['email'], { unique: true })
@Index(['status'], { where: "status = 'active'" })
export class User extends BaseEntity {
  @Column({ type: 'varchar', length: 255, unique: true, nullable: false })
  email: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  @Exclude()
  passwordHash: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  firstName: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  lastName: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone: string;

  @Column({ type: 'varchar', length: 10, default: 'en', nullable: false })
  locale: string;

  @Column({ type: 'varchar', length: 50, default: 'UTC', nullable: false })
  timezone: string;

  @Column({ type: 'boolean', default: false, nullable: false })
  mfaEnabled: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @Exclude()
  mfaSecret: string;

  // Last two-factor time step accepted: a code is good once (replay protection)
  @Column({ type: 'bigint', nullable: true })
  @Exclude()
  mfaLastUsedStep: string | null;

  // Wrong passwords / codes in a row; reaching the limit locks the account a while
  @Column({ type: 'integer', default: 0 })
  @Exclude()
  failedLoginCount: number;

  @Column({ type: 'timestamptz', nullable: true })
  @Exclude()
  lockedUntil: Date | null;

  @Column({
    type: 'enum',
    enum: UserStatus,
    default: UserStatus.ACTIVE,
    nullable: false,
  })
  status: UserStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt: Date;

  // Relations
  @OneToMany(() => TenantMembership, (membership) => membership.user)
  tenants: TenantMembership[];

  // Virtual fields
  get fullName(): string {
    if (this.firstName && this.lastName) {
      return `${this.firstName} ${this.lastName}`;
    }
    return this.firstName || this.lastName || this.email;
  }
}
