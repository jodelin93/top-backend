import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { createWriteStream } from 'fs';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { finished } from 'stream/promises';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import {
  ReportRunnerService,
  reportFilename,
} from '../reports/report-runner.service';
import { CONTENT_TYPES } from '../reports/report-files';
import { resolvePermissions } from '../roles/role-permissions';
import { isBranchSubset, membershipBranchIds } from '../auth/branch-scope';
import type { RunReportQueryDto } from '../reports/reports.dto';
import {
  DEFAULT_FILE_TTL_HOURS,
  ExportJobRow,
  fileExpiry,
  MAX_ATTEMPTS,
  returnedRows,
  STALE_RUNNING_MINUTES,
} from './export-logic';

// How often the worker looks for queued jobs
export const EXPORT_POLL_INTERVAL_MS = 5_000;
// Jobs handled per tick at most (one at a time)
const JOBS_PER_TICK = 5;

/**
 * Builds queued report exports in the background (spec §14).
 *
 * A plain setInterval loop (like ReservationExpiryService): one job at a time
 * per API instance, so exports never compete with checkout for more than one
 * database connection, and several instances share the queue safely — each job
 * is claimed with FOR UPDATE SKIP LOCKED. Rows are streamed through a cursor
 * into a temporary file, which is then stored privately. Files are deleted
 * once they expire; jobs abandoned by a stopped instance are retried.
 */
@Injectable()
export class ExportWorkerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ExportWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private warnedMissingTable = false;
  private readonly ttlHours: number;

  constructor(
    private dataSource: DataSource,
    private runner: ReportRunnerService,
    private storage: StorageService,
    private auditService: AuditService,
    config: ConfigService,
  ) {
    const ttl = Number(config.get<string | number>('EXPORT_TTL_HOURS'));
    this.ttlHours = ttl > 0 ? ttl : DEFAULT_FILE_TTL_HOURS;
  }

  onApplicationBootstrap() {
    if (process.env.EXPORT_WORKER === 'off') return;
    this.timer = setInterval(() => {
      void this.tick();
    }, EXPORT_POLL_INTERVAL_MS);
    // Never keep the process alive just for this
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass: housekeeping, then queued jobs one after the other */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    try {
      await this.requeueStale();
      await this.deleteExpired();
      for (let i = 0; i < JOBS_PER_TICK; i++) {
        const job = await this.claim();
        if (!job) break;
        await this.process(job);
        processed++;
      }
    } catch (error) {
      // Table not created yet (migration pending): say so once, not every tick
      if ((error as { code?: string })?.code === '42P01') {
        if (!this.warnedMissingTable) {
          this.warnedMissingTable = true;
          this.logger.warn(
            'export_jobs table missing: run the ReportsExports migration',
          );
        }
      } else {
        this.logger.error(
          `Export worker failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      this.running = false;
    }
    return processed;
  }

  /** Take the oldest queued job; other instances skip it (SKIP LOCKED) */
  async claim(): Promise<ExportJobRow | null> {
    const result: unknown = await this.dataSource.query(
      `UPDATE export_jobs
          SET status = 'running', "startedAt" = now(), attempts = attempts + 1,
              error = NULL, updated_at = now()
        WHERE id = (SELECT id FROM export_jobs WHERE status = 'queued'
                     ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *`,
    );
    return returnedRows<ExportJobRow>(result)[0] ?? null;
  }

  /** Build the file of a claimed job and store it privately */
  async process(job: ExportJobRow): Promise<void> {
    let dir: string | null = null;
    try {
      // Built with the owner's permissions as of now, not when it was queued
      const permissions = await this.permissionsOf(job.tenantId, job.userId);
      if (!permissions.includes('reports.export')) {
        throw new Error('The user may no longer export reports');
      }
      // …and within the branches they may see now (access may have been narrowed)
      const current = await this.branchScopeOf(job.tenantId, job.userId);
      if (!isBranchSubset(job.scope?.branchIds ?? null, current)) {
        throw new Error('The user no longer has access to these branches');
      }
      const params = job.params as RunReportQueryDto;
      const prepared = this.runner.prepare(
        job.tenantId,
        job.reportKey,
        params,
        permissions,
        job.scope ?? undefined,
      );
      dir = await mkdtemp(join(tmpdir(), 'report-export-'));
      const path = join(dir, `export.${job.format}`);
      const out = createWriteStream(path);
      const rowCount = await this.runner.writeFile(
        job.tenantId,
        prepared,
        job.format,
        out,
      );
      if (!out.writableFinished) await finished(out);
      const { size } = await stat(path);
      const key = this.storage.newPrivateKey(
        `exports/${job.tenantId}`,
        job.format,
      );
      await this.storage.putPrivateFile(key, path, CONTENT_TYPES[job.format]);
      const finishedAt = new Date();
      await this.dataSource.query(
        `UPDATE export_jobs
            SET status = 'done', "rowCount" = $2, "fileKey" = $3, "fileName" = $4, "fileSize" = $5,
                "finishedAt" = $6, "expiresAt" = $7, updated_at = now()
          WHERE id = $1`,
        [
          job.id,
          rowCount,
          key,
          reportFilename(job.reportKey, params, job.format),
          size,
          finishedAt,
          fileExpiry(finishedAt, this.ttlHours),
        ],
      );
      await this.auditService.record({
        tenantId: job.tenantId,
        actorId: job.userId,
        action: 'report.exported',
        entityType: 'report',
        entityId: job.reportKey,
        metadata: {
          format: job.format,
          background: true,
          exportJobId: job.id,
          from: params.from ?? null,
          to: params.to ?? null,
          branchIds: prepared.branchIds,
          rows: rowCount,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Export ${job.id} failed: ${message}`);
      await this.dataSource.query(
        `UPDATE export_jobs SET status = 'failed', error = $2, "finishedAt" = now(), updated_at = now()
          WHERE id = $1`,
        [job.id, message.slice(0, 1000)],
      );
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  }

  /** Delete the files of expired exports */
  async deleteExpired(): Promise<number> {
    const result: unknown = await this.dataSource.query(
      `WITH due AS (
         SELECT id, "fileKey" FROM export_jobs
          WHERE "fileKey" IS NOT NULL AND "expiresAt" <= now()
          ORDER BY "expiresAt" LIMIT 100 FOR UPDATE SKIP LOCKED
       ), cleared AS (
         UPDATE export_jobs j SET status = 'expired', "fileKey" = NULL, updated_at = now()
           FROM due WHERE j.id = due.id RETURNING j.id
       )
       SELECT due.id, due."fileKey" AS "oldKey" FROM due JOIN cleared ON cleared.id = due.id`,
    );
    const rows = returnedRows<{ id: string; oldKey: string | null }>(result);
    for (const row of rows) {
      if (row.oldKey) await this.storage.deletePrivate(row.oldKey);
    }
    return rows.length;
  }

  /** Jobs left "running" by a stopped instance: retry, or give up after MAX_ATTEMPTS */
  async requeueStale(): Promise<void> {
    await this.dataSource.query(
      `UPDATE export_jobs
          SET status = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'failed' ELSE 'queued' END,
              error = CASE WHEN attempts >= ${MAX_ATTEMPTS} THEN 'Export interrupted too many times' ELSE error END,
              updated_at = now()
        WHERE status = 'running' AND "startedAt" < now() - interval '${STALE_RUNNING_MINUTES} minutes'`,
    );
  }

  /** The job owner's branches as of now (null = every branch) */
  private async branchScopeOf(tenantId: string, userId: string) {
    const [membership] = await this.dataSource.query<
      { role: string; branchIds: string[] | null }[]
    >(
      `SELECT role, "branchIds" FROM tenant_memberships
        WHERE "tenantId" = $1 AND "userId" = $2 AND status = 'active' LIMIT 1`,
      [tenantId, userId],
    );
    return membership ? membershipBranchIds(membership) : [];
  }

  private async permissionsOf(tenantId: string, userId: string) {
    const [membership] = await this.dataSource.query<
      { role: string; permissions: string[] | null }[]
    >(
      `SELECT m.role, r.permissions
         FROM tenant_memberships m
         JOIN users u ON u.id = m."userId" AND u.status = 'active'
         LEFT JOIN tenant_roles r ON r."tenantId" = m."tenantId" AND r.key = m.role
        WHERE m."tenantId" = $1 AND m."userId" = $2 AND m.status = 'active'
        LIMIT 1`,
      [tenantId, userId],
    );
    if (!membership) return [];
    return resolvePermissions(
      membership.role,
      membership.permissions ? { permissions: membership.permissions } : null,
    );
  }
}
