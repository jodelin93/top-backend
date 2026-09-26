import { Column, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

/**
 * Stored outcome of a command sent with an Idempotency-Key header (see
 * src/common/idempotency). A row without responseStatus is still in progress.
 */
@Entity('idempotency_records')
@Unique('uq_idempotency_records_key', ['tenantId', 'key'])
@Index('IDX_idempotency_records_expires', ['expiresAt'])
export class IdempotencyRecord {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_idempotency_records',
  })
  id: string;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  key: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  commandType: string;

  // sha256 of the command type, path and body
  @Column({ type: 'char', length: 64, nullable: false })
  requestHash: string;

  @Column({ type: 'int', nullable: true })
  responseStatus: number | null;

  @Column({ type: 'jsonb', nullable: true })
  responseBody: unknown;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: false })
  expiresAt: Date;
}
