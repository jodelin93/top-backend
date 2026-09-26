import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { getJwtSecret } from '../config/jwt.config';
import {
  canRunReport,
  ReportRunnerService,
} from '../reports/report-runner.service';
import { findReport } from '../reports/report-definitions';
import type { ReportScope } from '../reports/report-sql';
import type { RunReportQueryDto } from '../reports/reports.dto';
import { CreateExportDto } from './exports.dto';
import { isBranchSubset } from '../auth/branch-scope';
import {
  DOWNLOAD_LINK_SECONDS,
  ExportJobRow,
  isDownloadable,
  jobView,
  returnedRows,
  signDownloadToken,
  verifyDownloadToken,
} from './export-logic';

// Parameters a job keeps (whatever else the client sent is dropped)
const PARAM_KEYS: (keyof RunReportQueryDto)[] = [
  'from',
  'to',
  'timezone',
  'branchId',
  'variantId',
  'locationId',
];

export const pickParams = (params?: RunReportQueryDto): RunReportQueryDto =>
  Object.fromEntries(
    PARAM_KEYS.filter(
      (k) => params?.[k] !== undefined && params[k] !== null,
    ).map((k) => [k, params![k]]),
  );

/**
 * Background report exports (spec §14): POST queues a job, ExportWorkerService
 * builds the file into private storage, and GET issues a short-lived download
 * link after checking — again, at download time — that the user may still
 * export this report.
 */
@Injectable()
export class ExportsService {
  private readonly secret: string;

  constructor(
    private dataSource: DataSource,
    private runner: ReportRunnerService,
    private storage: StorageService,
    private auditService: AuditService,
    private config: ConfigService,
  ) {
    this.secret = getJwtSecret(config);
  }

  /** Queue an export. The report, its parameters and access are checked now. */
  async create(
    tenantId: string,
    userId: string,
    dto: CreateExportDto,
    permissions: readonly string[],
    scope?: ReportScope,
  ) {
    const params = pickParams(dto.params);
    // Throws on an unknown report, missing parameters or no access
    this.runner.prepare(tenantId, dto.reportKey, params, permissions, scope);
    const rows = await this.dataSource.query<ExportJobRow[]>(
      `INSERT INTO export_jobs ("tenantId", "userId", "reportKey", params, scope, format)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        tenantId,
        userId,
        dto.reportKey,
        JSON.stringify(params),
        scope ? JSON.stringify(scope) : null,
        dto.format,
      ],
    );
    const job = returnedRows<ExportJobRow>(rows)[0];
    await this.auditService.record({
      tenantId,
      action: 'report.export_queued',
      entityType: 'export_job',
      entityId: job.id,
      metadata: { reportKey: dto.reportKey, format: dto.format, params },
    });
    return jobView(job);
  }

  /** The user's own exports of the last 7 days, newest first */
  async list(tenantId: string, userId: string) {
    const rows = await this.dataSource.query<ExportJobRow[]>(
      `SELECT * FROM export_jobs
       WHERE "tenantId" = $1 AND "userId" = $2 AND created_at > now() - interval '7 days'
       ORDER BY created_at DESC LIMIT 50`,
      [tenantId, userId],
    );
    return rows.map((row) => jobView(row));
  }

  /**
   * Status, and a download link valid DOWNLOAD_LINK_SECONDS when the file is
   * ready — only while the user may still export this report.
   */
  async get(
    tenantId: string,
    userId: string,
    id: string,
    permissions: readonly string[],
    scope?: ReportScope,
  ) {
    const job = await this.find(tenantId, userId, id);
    const view = jobView(job);
    if (!isDownloadable(job)) return { ...view, downloadUrl: null };
    this.assertMayDownload(job, permissions, scope);
    const expires = new Date(Date.now() + DOWNLOAD_LINK_SECONDS * 1000);
    const downloadUrl =
      (await this.storage.privateDownloadUrl(
        job.fileKey!,
        job.fileName ?? 'export',
        DOWNLOAD_LINK_SECONDS,
      )) ??
      `${this.apiBaseUrl()}/exports/download/${signDownloadToken(this.secret, job.id, expires)}`;
    await this.auditService.record({
      tenantId,
      action: 'report.export_downloaded',
      entityType: 'export_job',
      entityId: job.id,
      metadata: { reportKey: job.reportKey, format: job.format },
    });
    return { ...view, downloadUrl, downloadUrlExpiresAt: expires };
  }

  /** Remove a job (and its file) */
  async remove(tenantId: string, userId: string, id: string) {
    const job = await this.find(tenantId, userId, id);
    if (job.fileKey) await this.storage.deletePrivate(job.fileKey);
    await this.dataSource.query(
      `DELETE FROM export_jobs WHERE id = $1 AND "tenantId" = $2`,
      [job.id, tenantId],
    );
  }

  /**
   * Local storage: resolve a signed download token to the file to send. The
   * token was issued after the permission check and expires within minutes.
   */
  async resolveDownload(token: string) {
    const id = verifyDownloadToken(this.secret, token);
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new NotFoundException('This download link has expired');
    }
    const [job] = await this.dataSource.query<ExportJobRow[]>(
      `SELECT * FROM export_jobs WHERE id = $1`,
      [id],
    );
    if (!job || !isDownloadable(job)) {
      throw new NotFoundException('This download link has expired');
    }
    return {
      path: this.storage.privateLocalPath(job.fileKey!),
      fileName: job.fileName ?? `export.${job.format}`,
      format: job.format,
    };
  }

  /**
   * reports.export and the report's own permissions, as of now — and the
   * branches the file covers must still be ones the user may see
   */
  assertMayDownload(
    job: Pick<ExportJobRow, 'reportKey'> & Partial<Pick<ExportJobRow, 'scope'>>,
    permissions: readonly string[],
    scope?: ReportScope,
  ) {
    if (
      !isBranchSubset(job.scope?.branchIds ?? null, scope?.branchIds ?? null)
    ) {
      throw new NotFoundException('Export not found');
    }
    const report = findReport(job.reportKey);
    if (
      !report ||
      !permissions.includes('reports.view') ||
      !permissions.includes('reports.export') ||
      !canRunReport(report, permissions)
    ) {
      throw new ForbiddenException(
        'You no longer have permission to download this export',
      );
    }
  }

  private async find(tenantId: string, userId: string, id: string) {
    const [job] = await this.dataSource.query<ExportJobRow[]>(
      `SELECT * FROM export_jobs WHERE id = $1 AND "tenantId" = $2 AND "userId" = $3`,
      [id, tenantId, userId],
    );
    if (!job) throw new NotFoundException('Export not found');
    return job;
  }

  // Public base URL of this API (as for stored files)
  private apiBaseUrl() {
    const get = (name: string) => {
      const value = this.config.get<string | number>(name);
      return value === undefined || value === null ? '' : `${value}`.trim();
    };
    const prefix = (get('API_PREFIX') || 'api/v1').replace(/^\/+|\/+$/g, '');
    return (
      get('STORAGE_PUBLIC_BASE_URL') ||
      `http://localhost:${get('PORT') || '3000'}/${prefix}`
    ).replace(/\/+$/, '');
  }
}
