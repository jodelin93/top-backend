import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ReportsService } from './reports.service';
import { ReportRunnerService } from './report-runner.service';
import { DailySummaryQueryDto } from './reports.dto';
import type { ReportColumn } from './report-definitions';
import type { ReportScope } from './report-sql';
import { pdfBuffer, pdfHeader, pdfSection, pdfTable } from './report-files';

type Row = Record<string, unknown>;

// Sales figures printed per currency (rows), one column per currency
const SALES_LINES: { key: string; label: string; count?: boolean }[] = [
  { key: 'saleCount', label: 'Sales', count: true },
  // A quantity: measured items (kg, m, l) count with their decimals
  { key: 'itemsSold', label: 'Quantity sold', count: true },
  { key: 'lineCount', label: 'Lines sold', count: true },
  { key: 'grossSales', label: 'Gross sales (excl. tax)' },
  { key: 'discounts', label: 'Discounts (excl. tax)' },
  { key: 'returns', label: 'Returns (excl. tax)' },
  { key: 'netSales', label: 'Net sales (excl. tax)' },
  { key: 'tax', label: 'Tax on sales' },
  { key: 'returnTax', label: 'Tax refunded' },
  { key: 'netTax', label: 'Net tax' },
  { key: 'returnCount', label: 'Returns', count: true },
  { key: 'refundsInclTax', label: 'Refunds (incl. tax)' },
  { key: 'totalCollectedInclTax', label: 'Total collected (incl. tax)' },
];

/**
 * Printable end-of-day summary for the whole store (or one branch), Z-report
 * style: sales and tax per currency, tenders per currency, refunds and the cash
 * variance of each shift. Built from the same queries as the dashboard and the
 * reports, so the figures always agree.
 */
@Injectable()
export class DailySummaryService {
  constructor(
    private dataSource: DataSource,
    private reports: ReportsService,
    private runner: ReportRunnerService,
    private auditService: AuditService,
  ) {}

  async pdf(
    tenantId: string,
    query: DailySummaryQueryDto,
    permissions: readonly string[] = [],
    scope?: ReportScope,
  ): Promise<{ filename: string; contentType: string; body: Buffer }> {
    const timezone = query.timezone ?? 'UTC';
    // The local calendar day in the store's time zone
    const [day] = await this.dataSource.query<{ from: Date; to: Date }[]>(
      `SELECT ($1::date::timestamp AT TIME ZONE $2) AS "from",
              (($1::date + 1)::timestamp AT TIME ZONE $2) - interval '1 millisecond' AS "to"`,
      [query.date, timezone],
    );
    const from = new Date(day.from).toISOString();
    const to = new Date(day.to).toISOString();
    const range = { from, to, timezone, branchId: query.branchId };

    const summary = await this.reports.summary(
      tenantId,
      range,
      permissions,
      scope,
    );
    const tenders = await this.runner.run(
      tenantId,
      'payments-by-method',
      range,
      permissions,
      scope,
    );
    const shifts = await this.runner.run(
      tenantId,
      'shifts',
      range,
      permissions,
      scope,
    );
    const header = await this.runner.fileHeader(tenantId, {
      report: {
        key: 'daily-summary',
        title: `Daily summary — ${query.date}`,
        description:
          'Sales, tax, tenders, refunds and cash variance for the day. Amounts in different currencies are never added together.',
        group: 'Sales',
        usesDateRange: true,
        branchFilter: true,
        columns: [],
        sql: '',
      },
      branchIds: summary.branchIds,
      period: { from, to, timezone },
    });
    header.currency = null;

    const currencies = [summary.totals, ...summary.otherCurrencies];
    const salesColumns: ReportColumn[] = [
      { key: 'label', label: 'Figure', type: 'text' },
      ...currencies.map((c) => ({
        key: c.currencyCode,
        label: c.currencyCode,
        type: 'number' as const,
      })),
    ];
    const salesRows: Row[] = SALES_LINES.map((line) => ({
      label: line.label,
      ...Object.fromEntries(
        currencies.map((c) => {
          const value = Number((c as unknown as Row)[line.key] ?? 0);
          return [
            c.currencyCode,
            line.count ? value : Math.round(value * 100) / 100,
          ];
        }),
      ),
    }));
    const shiftColumns = shifts.columns.filter((c) =>
      [
        'shiftNumber',
        'register',
        'closedAt',
        'currency',
        'expectedCash',
        'countedCash',
        'variance',
        'lateSales',
        'status',
      ].includes(c.key),
    );

    const body = await pdfBuffer((doc) => {
      pdfHeader(doc, header);
      if (!summary.freshness.complete) {
        doc
          .font('Helvetica-Oblique')
          .fontSize(8)
          .fillColor('#9a3412')
          .text(
            `Figures may be incomplete: ${summary.freshness.pendingSales} sale(s) are still waiting on tills to upload.`,
          )
          .fillColor('#000000')
          .moveDown(0.5);
      }
      pdfSection(doc, 'Sales and tax');
      pdfTable(doc, salesColumns, salesRows, timezone);
      pdfSection(doc, 'Tenders (net of change and refunds)');
      pdfTable(doc, tenders.columns, tenders.rows, timezone);
      pdfSection(doc, 'Cash variance by shift');
      pdfTable(doc, shiftColumns, shifts.rows, timezone);
      if (summary.cashVariance.length > 0) {
        doc
          .font('Helvetica-Bold')
          .fontSize(9)
          .text(
            'Total cash variance of closed shifts: ' +
              summary.cashVariance
                .map((v) => `${v.amount.toFixed(2)} ${v.currencyCode}`)
                .join(' · '),
          );
      }
      doc
        .moveDown(1)
        .font('Helvetica')
        .fontSize(7)
        .fillColor('#666666')
        .text(`Generated ${summary.generatedAt}`);
    }, header.title);

    await this.auditService.record({
      tenantId,
      action: 'report.exported',
      entityType: 'report',
      entityId: 'daily-summary',
      metadata: {
        format: 'pdf',
        date: query.date,
        branchIds: summary.branchIds,
      },
    });

    return {
      filename: `daily-summary-${query.date}.pdf`,
      contentType: 'application/pdf',
      body,
    };
  }
}
