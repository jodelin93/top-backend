import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Append-only record of sensitive operations. A database trigger rejects
 * UPDATE and DELETE (see the AddRolesAndAudit migration).
 */
@Entity('audit_logs')
@Index('IDX_audit_tenant_created', ['tenantId', 'createdAt'])
@Index('IDX_audit_tenant_entity', ['tenantId', 'entityType', 'entityId'])
@Index('IDX_audit_tenant_action', ['tenantId', 'action'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  // Null for system actions (e.g. offline sync, scheduled jobs)
  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

  // Set when another user approved the action (separation of duties)
  @Column({ type: 'uuid', nullable: true })
  approverId: string | null;

  // e.g. 'sale.void', 'user.role_changed', 'product.updated'
  @Column({ type: 'varchar', length: 100, nullable: false })
  action: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  entityType: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  entityId: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  reason: string | null;

  // { before, after } for updates; the created/deleted record otherwise
  @Column({ type: 'jsonb', nullable: true })
  changes: Record<string, unknown> | null;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  metadata: Record<string, unknown>;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  requestId: string | null;
}
