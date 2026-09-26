import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import {
  findReport,
  REPORTS,
  ReportColumn,
  ReportDefinition,
} from './report-definitions';
import { RunReportQueryDto, type ExportFormat } from './reports.dto';
import {
  assertStoreWide,
  bindParams,
  branchFilter,
  type ReportScope,
} from './report-sql';
import { dataFreshness, type DataFreshness } from './freshness';
import {
  CONTENT_TYPES,
  createReportWriter,
  reportFile,
  ReportFileHeader,
  TotalsAccumulator,
} from './report-files';
import type { Writable } from 'stream';

type Row = Record<string, unknown>;

export interface ReportResult {
  key: string;
  title: string;
  description: string;
  period: { from: string | null; to: string | null; timezone: string };
  // Branches the figures are limited to (null: every branch)
  branchIds: string[] | null;
  columns: ReportColumn[];
  rows: Row[];
  totals: Row;
  // Rows in more than one currency: money columns are not totalled
  mixedCurrencies: boolean;
  generatedAt: string;
  freshness: DataFreshness;
}

/** A report ready to execute: checked, parameters bound, visible columns */
export interface PreparedReport {
  report: ReportDefinition;
  sql: string;
  values: unknown[];
  columns: ReportColumn[];
  branchIds: string[] | null;
  period: ReportResult['period'];
}

const NUMERIC_TYPES = new Set(['number', 'money', 'percent']);

// Larger synchronous exports must go through a background export
export const SYNC_EXPORT_MAX_ROWS = 20_000;
// Rows fetched per round trip when streaming a background export
const CURSOR_BATCH = 2000;

/** Columns the user may see: cost, profit and margin need inventory.cost.view */
export const visibleColumns = (
  columns: ReportColumn[],
  permissions: readonly string[],
) =>
  columns.filter(
    (column) => !column.requires || permissions.includes(column.requires),
  );

/** May run the report: reports.view (checked by the controller) + any one of `requires` */
export const canRunReport = (
  report: Pick<ReportDefinition, 'requires'>,
  permissions: readonly string[],
) =>
  !report.requires ||
  report.requires.length === 0 ||
  report.requires.some((permission) => permissions.includes(permission));

/**
 * Totals row. Counts are always summed; money only when every row is in the
 * same currency (amounts in different currencies are never added together).
 */
export function reportTotals(columns: ReportColumn[], rows: Row[]) {
  const totals = new TotalsAccumulator(columns);
  totals.add(rows);
  return totals.result();
}

/** pg returns COUNT/SUM over bigint as strings; keep visible columns, normalised */
export const normaliseRows = (raw: Row[], columns: ReportColumn[]): Row[] =>
  raw.map((row) =>
    Object.fromEntries(
      columns.map((column) => {
        const value = row[column.key];
        if (value === null || value === undefined) return [column.key, null];
        if (NUMERIC_TYPES.has(column.type)) return [column.key, Number(value)];
        if (value instanceof Date) return [column.key, value.toISOString()];
        return [column.key, value];
      }),
    ),
  );

@Injectable()
export class ReportRunnerService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {}

  /** Reports this user may run, with the columns they may see */
  catalog(permissions: readonly string[] = [], scope?: ReportScope) {
    return REPORTS.filter(
      (report) =>
        canRunReport(report, permissions) &&
        // Store-wide reports aren't offered to branch-limited users
        (report.branchFilter || !scope?.branchIds),
    ).map(
      ({
        key,
        title,
        description,
        group,
        usesDateRange,
        branchFilter: branches,
        parameters,
        columns,
      }) => ({
        key,
        title,
        description,
        group,
        usesDateRange,
        branchFilter: branches,
        parameters: parameters ?? [],
        columns: visibleColumns(columns, permissions),
      }),
    );
  }

  /**
   * Check access and inputs, and bind the parameters. The scope restricts every
   * branch-aware query; store-wide reports are refused to branch-limited users.
   */
  prepare(
    tenantId: string,
    key: string,
    query: RunReportQueryDto,
    permissions: readonly string[] = [],
    scope?: ReportScope,
  ): PreparedReport {
    const report = this.find(key);
    if (!canRunReport(report, permissions)) {
      throw new ForbiddenException(
        `You need one of these permissions for this report: ${report.requires!.join(', ')}`,
      );
    }
    if (report.usesDateRange && (!query.from || !query.to)) {
      throw new BadRequestException('from and to are required for this report');
    }
    for (const parameter of report.parameters ?? []) {
      if (parameter.required && !query[parameter.key]) {
        throw new BadRequestException(`${parameter.key} is required`);
      }
    }
    let branchIds: string[] | null = null;
    if (report.branchFilter) {
      branchIds = branchFilter(query.branchId, scope);
    } else {
      assertStoreWide(query.branchId, scope);
    }
    const timezone = query.timezone ?? 'UTC';
    const { sql, values } = bindParams(report.sql, [
      tenantId,
      query.from ?? null,
      query.to ?? null,
      timezone,
      branchIds,
      query.variantId ?? null,
      query.locationId ?? null,
    ]);
    return {
      report,
      sql,
      values,
      // Hidden columns are dropped here, so they never reach the API or an export
      columns: visibleColumns(report.columns, permissions),
      branchIds,
      period: {
        from: report.usesDateRange ? (query.from ?? null) : null,
        to: report.usesDateRange ? (query.to ?? null) : null,
        timezone,
      },
    };
  }

  async run(
    tenantId: string,
    key: string,
    query: RunReportQueryDto,
    permissions: readonly string[] = [],
    scope?: ReportScope,
  ): Promise<ReportResult> {
    const prepared = this.prepare(tenantId, key, query, permissions, scope);
    const raw = await this.dataSource.query<Row[]>(
      prepared.sql,
      prepared.values,
    );
    const rows = normaliseRows(raw, prepared.columns);
    const { totals, mixedCurrencies } = reportTotals(prepared.columns, rows);
    const freshness = await dataFreshness(
      this.dataSource,
      tenantId,
      prepared.branchIds,
    );

    return {
      key: prepared.report.key,
      title: prepared.report.title,
      description: prepared.report.description,
      period: prepared.period,
      branchIds: prepared.branchIds,
      columns: prepared.columns,
      rows,
      totals,
      mixedCurrencies,
      generatedAt: freshness.generatedAt,
      freshness,
    };
  }

  /**
   * Stream a prepared report's rows in batches through a server-side cursor,
   * in a read-only transaction on its own connection (background exports: no
   * result is ever held in memory whole).
   */
  async stream(
    prepared: PreparedReport,
    onBatch: (rows: Row[]) => Promise<void>,
  ): Promise<number> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    let count = 0;
    try {
      await runner.query('BEGIN TRANSACTION READ ONLY');
      await runner.query(`SET LOCAL statement_timeout = '15min'`);
      await runner.query(
        `DECLARE report_export NO SCROLL CURSOR FOR ${prepared.sql}`,
        prepared.values,
      );
      for (;;) {
        const raw = (await runner.query(
          `FETCH FORWARD ${CURSOR_BATCH} FROM report_export`,
        )) as Row[];
        if (raw.length === 0) break;
        count += raw.length;
        await onBatch(normaliseRows(raw, prepared.columns));
        if (raw.length < CURSOR_BATCH) break;
      }
      await runner.query('CLOSE report_export');
      await runner.query('COMMIT');
    } catch (error) {
      await runner.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await runner.release();
    }
    return count;
  }

  /**
   * Write a whole report file to `out`, streaming (background exports).
   * Returns the number of rows.
   */
  async writeFile(
    tenantId: string,
    prepared: PreparedReport,
    format: ExportFormat,
    out: Writable,
  ): Promise<number> {
    const header = await this.fileHeader(tenantId, prepared);
    const writer = createReportWriter(format, out, prepared.columns, header);
    const totals = new TotalsAccumulator(prepared.columns);
    const count = await this.stream(prepared, async (rows) => {
      totals.add(rows);
      await writer.write(rows);
    });
    const result = totals.result();
    await writer.end(result.totals, result.mixedCurrencies);
    return count;
  }

  /**
   * CSV, Excel or PDF file of a report (audited: exports take data out of the
   * system). Large results must use a background export.
   */
  async export(
    tenantId: string,
    key: string,
    query: RunReportQueryDto,
    format: ExportFormat,
    permissions: readonly string[] = [],
    scope?: ReportScope,
  ): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const result = await this.run(tenantId, key, query, permissions, scope);
    if (result.rows.length > SYNC_EXPORT_MAX_ROWS) {
      throw new BadRequestException(
        `This report has ${result.rows.length} rows: use "Export in background" for more than ${SYNC_EXPORT_MAX_ROWS}`,
      );
    }

    await this.auditService.record({
      tenantId,
      action: 'report.exported',
      entityType: 'report',
      entityId: key,
      metadata: {
        format,
        from: query.from ?? null,
        to: query.to ?? null,
        branchIds: result.branchIds,
        rows: result.rows.length,
      },
    });

    const header = await this.fileHeader(tenantId, {
      report: this.find(key),
      branchIds: result.branchIds,
      period: result.period,
    });
    header.currency = result.mixedCurrencies
      ? null
      : ((result.rows.find((r) => r.currency)?.currency as string) ??
        header.currency);
    const body = await reportFile(
      format,
      result.columns,
      header,
      result.rows,
      result.totals,
      result.mixedCurrencies,
    );
    return {
      filename: reportFilename(result.key, query, format),
      contentType: CONTENT_TYPES[format],
      body,
    };
  }

  /** Store, branch names and store currency for a file header */
  async fileHeader(
    tenantId: string,
    prepared: Pick<PreparedReport, 'report' | 'branchIds' | 'period'>,
  ): Promise<ReportFileHeader> {
    const [tenant] = await this.dataSource.query<
      { name: string; currency: string | null }[]
    >(
      `SELECT t.name, t.settings->>'currencyCode' AS currency FROM tenants t WHERE t.id = $1`,
      [tenantId],
    );
    const branches = prepared.branchIds
      ? await this.dataSource.query<{ name: string }[]>(
          `SELECT b.name FROM branches b WHERE b."tenantId" = $1 AND b.id = ANY($2::uuid[]) ORDER BY b.name`,
          [tenantId, prepared.branchIds],
        )
      : [];
    return {
      title: prepared.report.title,
      description: prepared.report.description,
      storeName: tenant?.name ?? '',
      branches: prepared.branchIds
        ? branches.length > 0
          ? branches.map((b) => b.name)
          : ['(none)']
        : [],
      period: prepared.period,
      generatedAt: new Date(),
      currency: tenant?.currency ?? 'USD',
    };
  }

  private find(key: string): ReportDefinition {
    const report = findReport(key);
    if (!report) throw new NotFoundException(`Unknown report: ${key}`);
    return report;
  }
}

/** e.g. sales-by-day-2026-09-01-to-2026-09-30.csv */
export function reportFilename(
  key: string,
  query: Pick<RunReportQueryDto, 'from' | 'to'>,
  format: ExportFormat,
) {
  const stamp = (query.from ?? new Date().toISOString()).slice(0, 10);
  return `${key}-${stamp}${query.to ? `-to-${query.to.slice(0, 10)}` : ''}.${format}`;
}
