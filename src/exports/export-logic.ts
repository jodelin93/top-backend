/**
 * Background export rules (spec §14): job states, file lifetime and the signed,
 * short-lived download tokens. Pure functions, unit tested in exports.spec.ts.
 */
import { createHmac, timingSafeEqual } from 'crypto';
import type { ExportFormat } from '../reports/reports.dto';

export type ExportStatus = 'queued' | 'running' | 'done' | 'failed' | 'expired';

export interface ExportJobRow {
  id: string;
  tenantId: string;
  userId: string;
  reportKey: string;
  params: Record<string, unknown>;
  scope: { branchIds?: string[] } | null;
  format: ExportFormat;
  status: ExportStatus;
  attempts: number;
  rowCount: number | null;
  fileKey: string | null;
  fileName: string | null;
  fileSize: string | number | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  expiresAt: Date | null;
  error: string | null;
  created_at: Date;
}

// Generated files are kept this long, then deleted
export const DEFAULT_FILE_TTL_HOURS = 24;
// A download link works this long after it is issued
export const DOWNLOAD_LINK_SECONDS = 15 * 60;
// A job "running" for longer than this was abandoned (instance stopped): retried
export const STALE_RUNNING_MINUTES = 30;
export const MAX_ATTEMPTS = 3;

/** When a file finished at `finishedAt` is deleted */
export const fileExpiry = (
  finishedAt: Date,
  ttlHours = DEFAULT_FILE_TTL_HOURS,
) => new Date(finishedAt.getTime() + ttlHours * 3_600_000);

/** Can the file still be downloaded? */
export const isDownloadable = (
  job: Pick<ExportJobRow, 'status' | 'fileKey' | 'expiresAt'>,
  now = new Date(),
) =>
  job.status === 'done' &&
  !!job.fileKey &&
  !!job.expiresAt &&
  new Date(job.expiresAt).getTime() > now.getTime();

/** API view of a job (never the storage key) */
export function jobView(job: ExportJobRow, now = new Date()) {
  const expired =
    job.status === 'expired' ||
    (job.status === 'done' && !isDownloadable(job, now));
  return {
    id: job.id,
    reportKey: job.reportKey,
    params: job.params,
    format: job.format,
    status: expired ? 'expired' : job.status,
    rowCount: job.rowCount,
    fileName: job.fileName,
    fileSize: job.fileSize === null ? null : Number(job.fileSize),
    createdAt: job.created_at,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    expiresAt: job.expiresAt,
    error: job.error,
  };
}

const b64url = (value: string) => Buffer.from(value).toString('base64url');

const signature = (secret: string, payload: string) =>
  createHmac('sha256', secret)
    .update(`export-download:${payload}`)
    .digest('base64url');

/** Token for one job's file, valid until `expiresAt` */
export function signDownloadToken(
  secret: string,
  jobId: string,
  expiresAt: Date,
): string {
  const payload = b64url(`${jobId}.${expiresAt.getTime()}`);
  return `${payload}.${signature(secret, payload)}`;
}

/** The job id of a valid, unexpired token; null otherwise */
export function verifyDownloadToken(
  secret: string,
  token: string,
  now = new Date(),
): string | null {
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(signature(secret, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  const [jobId, expires] = Buffer.from(payload, 'base64url')
    .toString('utf8')
    .split('.');
  if (!jobId || !/^\d+$/.test(expires ?? '')) return null;
  if (Number(expires) <= now.getTime()) return null;
  return jobId;
}

/** Row of an UPDATE … RETURNING (node-postgres returns [rows, count]) */
export function returnedRows<T>(result: unknown): T[] {
  if (Array.isArray(result) && Array.isArray(result[0])) {
    return result[0] as T[];
  }
  return (result ?? []) as T[];
}
