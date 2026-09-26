import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

export const DOCUMENT_TYPES = [
  'receipt',
  'invoice',
  'credit_note',
  'pro_forma',
  'z_report',
  'label',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const PRINT_JOB_STATUSES = [
  'queued',
  'sent',
  'printed',
  'failed',
  'unknown',
] as const;
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

// How the job reached paper: the local print bridge (ESC/POS) or the browser dialog
export type PrintChannel = 'bridge' | 'browser';

/**
 * One print of a document (spec §15): the original, every reprint, Z-reports and
 * labels. The POS records the job before printing and reports how it went.
 *
 * At most one live original per document (UQ_print_jobs_original: queued, sent,
 * printed or unknown). Anything printed after it is a numbered COPY; an uncertain
 * print (unknown) is retried as a COPY, never as a new original or a new sale.
 * Drawer kicks are not print jobs and are never replayed.
 */
@Entity('print_jobs')
@Index('IDX_print_jobs_document', ['tenantId', 'documentType', 'documentId'])
@Index('IDX_print_jobs_tenant_created', ['tenantId', 'createdAt'])
@Index('UQ_print_jobs_original', ['tenantId', 'documentType', 'documentId'], {
  unique: true,
  where: `"copy" = false AND "status" IN ('queued', 'sent', 'printed', 'unknown')`,
})
export class PrintJob {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_print_jobs' })
  id: string;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  documentType: DocumentType;

  @Column({ type: 'uuid', nullable: false })
  documentId: string;

  // Number printed on the document (sale number, return number...), for the history
  @Column({ type: 'varchar', length: 100, nullable: true })
  documentNumber: string | null;

  @Column({ type: 'boolean', nullable: false, default: false })
  copy: boolean;

  // 1, 2, ... for copies; null for the original
  @Column({ type: 'int', nullable: true })
  copyNumber: number | null;

  @Column({ type: 'uuid', nullable: true })
  deviceId: string | null;

  // Printer id as the print bridge names it; null for the browser dialog
  @Column({ type: 'varchar', length: 100, nullable: true })
  printerId: string | null;

  @Column({ type: 'varchar', length: 10, nullable: false, default: 'browser' })
  channel: PrintChannel;

  @Column({ type: 'varchar', length: 10, nullable: false, default: 'queued' })
  status: PrintJobStatus;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  // The job this one retries
  @Column({ type: 'uuid', nullable: true })
  retryOfId: string | null;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  updatedAt: Date;
}
