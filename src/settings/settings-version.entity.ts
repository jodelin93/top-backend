import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Tenant } from '../database/entities/tenant.entity';

/**
 * History of store settings. Every change is a version holding the changed values
 * (`changes`, applied on top of whatever is current when it takes effect) and the
 * full resulting settings (`snapshot`). A version with a future `effectiveFrom` is
 * a scheduled change: it is applied the first time settings are read after it is due.
 */
@Entity('settings_versions')
@Unique('uq_settings_versions_tenant_version', ['tenantId', 'version'])
@Index('IDX_settings_versions_tenant_effective', ['tenantId', 'effectiveFrom'])
export class SettingsVersion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  // 1, 2, 3... per store
  @Column({ type: 'int', nullable: false })
  version: number;

  @Column({ type: 'jsonb', nullable: false, default: {} })
  changes: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: false, default: [] })
  changedKeys: string[];

  // Full settings after this version (projected, for a scheduled version)
  @Column({ type: 'jsonb', nullable: false, default: {} })
  snapshot: Record<string, unknown>;

  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ type: 'timestamptz', nullable: false })
  effectiveFrom: Date;

  // Null while a scheduled version is waiting
  @Column({ type: 'timestamptz', nullable: true })
  appliedAt: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  cancelledBy: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  note: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_settings_versions_tenant',
  })
  tenant?: Tenant;
}
