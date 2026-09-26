import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export interface SystemCheckResult {
  key: string;
  label: string;
  passed: boolean;
  issueCount: number;
  // First issues found (references and details only)
  issues: {
    reference: string;
    expected?: number | null;
    actual?: number | null;
    detail?: string | null;
  }[];
}

/**
 * One run of the scheduled reconciliation checks (spec §18) for a store:
 * daily, or on demand from the System events page.
 */
@Entity('system_check_runs')
@Index('IDX_system_check_runs_tenant_started', ['tenantId', 'startedAt'])
export class SystemCheckRun {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_system_check_runs',
  })
  id: string;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  // 'scheduled' | 'manual'
  @Column({ type: 'varchar', length: 20, nullable: false })
  trigger: string;

  @Column({ type: 'uuid', nullable: true })
  requestedById: string | null;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  startedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt: Date | null;

  // 'running' | 'passed' | 'issues' | 'failed'
  @Column({ type: 'varchar', length: 20, nullable: false, default: 'running' })
  status: string;

  @Column({ type: 'jsonb', nullable: false, default: [] })
  results: SystemCheckResult[];

  @Column({ type: 'text', nullable: true })
  error: string | null;
}
