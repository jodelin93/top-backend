import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../database/entities/user.entity';
import { Tenant } from '../database/entities/tenant.entity';

/**
 * One signed-in session. The id is the `sid` claim of the access token, so a
 * session can be revoked (logout, "sign out everywhere", suspension) before the
 * token itself expires.
 */
@Entity('user_sessions')
@Index('IDX_user_sessions_user', ['userId'])
@Index('IDX_user_sessions_tenant', ['tenantId'])
export class UserSession {
  @PrimaryColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  // Store the session is currently working in (changes on store switch)
  @Column({ type: 'uuid', nullable: true })
  tenantId: string | null;

  // Written at most every few minutes (see SessionsService)
  @Column({ type: 'timestamptz', nullable: false })
  lastSeenAt: Date;

  @Column({ type: 'timestamptz', nullable: false })
  expiresAt: Date;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  userAgent: string | null;

  // POS device (devices.id) the session signed in from, when known
  @Column({ type: 'uuid', nullable: true })
  deviceId: string | null;

  // 'password', 'mfa' or 'signup'
  @Column({ type: 'varchar', length: 20, nullable: false, default: 'password' })
  authMethod: string;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  // e.g. 'logout', 'revoked_by_user', 'member_suspended', 'password_reset'
  @Column({ type: 'varchar', length: 50, nullable: true })
  revokedReason: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'FK_user_sessions_user',
  })
  user?: User;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_user_sessions_tenant',
  })
  tenant?: Tenant;
}
