/**
 * Report files (CSV, Excel, PDF), written incrementally so large background
 * exports stream rows to disk batch by batch instead of holding them in memory.
 * The same writers build the small synchronous downloads into a Buffer.
 */
import { PassThrough, Writable } from 'stream';
import { finished } from 'stream/promises';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { asText, CURRENCY_COLUMN, ReportColumn } from './report-definitions';
import { addQty, roundQty } from '../common/utils/quantity';

type Row = Record<string, unknown>;

export type ReportFileFormat = 'csv' | 'xlsx' | 'pdf';

export const CONTENT_TYPES: Record<ReportFileFormat, string> = {
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

// A PDF is for reading: longer results are cut (CSV / Excel have everything)
export const PDF_MAX_ROWS = 5000;

/** Header printed on PDFs (and above the table in a daily summary) */
export interface ReportFileHeader {
  title: string;
  description?: string;
  storeName: string;
  // Branch names, or empty for every branch
  branches: string[];
  period: { from: string | null; to: string | null; timezone: string };
  generatedAt: Date;
  // Currency of the money columns: one code, or null when rows have their own
  currency: string | null;
}

/**
 * Totals row built as rows stream past. Counts are always summed; money only
 * while every row is in one currency (currencies are never added together).
 */
export class TotalsAccumulator {
  private sums = new Map<string, number>();
  private currencies = new Set<unknown>();

  constructor(private columns: ReportColumn[]) {}

  add(rows: Row[]) {
    for (const row of rows) {
      const code = row[CURRENCY_COLUMN];
      if (code !== null && code !== undefined) this.currencies.add(code);
      for (const column of this.columns) {
        if (!column.total) continue;
        this.sums.set(
          column.key,
          addQty(this.sums.get(column.key) ?? 0, Number(row[column.key] ?? 0)),
        );
      }
    }
  }

  get mixedCurrencies() {
    return this.currencies.size > 1;
  }

  // The one currency of every row, if there is exactly one
  get currency(): string | null {
    return this.currencies.size === 1 ? asText([...this.currencies][0]) : null;
  }

  result(): { totals: Row; mixedCurrencies: boolean } {
    const totals: Row = {};
    for (const column of this.columns) {
      if (!column.total) continue;
      if (this.mixedCurrencies && column.type === 'money') continue;
      const sum = this.sums.get(column.key) ?? 0;
      // Quantities keep the decimals of measured items (1.25 kg); money is cents
      totals[column.key] =
        column.type === 'number' ? roundQty(sum) : Math.round(sum * 100) / 100;
    }
    return { totals, mixedCurrencies: this.mixedCurrencies };
  }
}

export interface ReportFileWriter {
  /** Write a batch of rows */
  write(rows: Row[]): Promise<void>;
  /** Totals row (if any), then close the output */
  end(totals: Row, mixedCurrencies: boolean): Promise<void>;
}

// ---- CSV ----

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = asText(value);
  // Neutralise spreadsheet formula injection from user-entered text
  if (/^[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text))) {
    text = `'${text}`;
  }
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const writeChunk = (out: Writable, chunk: string | Buffer) =>
  new Promise<void>((resolve, reject) => {
    out.write(chunk, (error) => (error ? reject(error) : resolve()));
  });

const endStream = (out: Writable) =>
  new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.end(() => resolve());
  });

class CsvWriter implements ReportFileWriter {
  private started = false;
  constructor(
    private out: Writable,
    private columns: ReportColumn[],
  ) {}

  private async header() {
    if (this.started) return;
    this.started = true;
    // BOM so Excel opens UTF-8 (accents in product names) correctly
    await writeChunk(
      this.out,
      '﻿' + this.columns.map((c) => csvCell(c.label)).join(','),
    );
  }

  async write(rows: Row[]) {
    await this.header();
    if (rows.length === 0) return;
    const lines = rows.map((row) =>
      this.columns.map((c) => csvCell(row[c.key])).join(','),
    );
    await writeChunk(this.out, '\r\n' + lines.join('\r\n'));
  }

  async end(totals: Row) {
    await this.header();
    if (Object.keys(totals).length > 0) {
      const line = this.columns
        .map((c, i) =>
          i === 0 ? 'Total' : c.key in totals ? csvCell(totals[c.key]) : '',
        )
        .join(',');
      await writeChunk(this.out, '\r\n' + line);
    }
    await endStream(this.out);
  }
}

// ---- Excel (streaming workbook writer) ----

class XlsxWriter implements ReportFileWriter {
  private workbook: ExcelJS.stream.xlsx.WorkbookWriter;
  private sheet: ExcelJS.Worksheet;

  constructor(
    out: Writable,
    private columns: ReportColumn[],
    title: string,
  ) {
    this.workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
      stream: out,
      useStyles: true,
    });
    this.sheet = this.workbook.addWorksheet(
      title.replace(/[*?:\\/[\]]/g, ' ').slice(0, 31),
      { views: [{ state: 'frozen', ySplit: 1 }] },
    );
    this.sheet.columns = columns.map((column) => ({
      header: column.label,
      key: column.key,
      width: Math.max(12, column.label.length + 4),
      style:
        column.type === 'money'
          ? { numFmt: '#,##0.00' }
          : column.type === 'percent'
            ? { numFmt: '0.0%' }
            : column.type === 'datetime'
              ? { numFmt: 'yyyy-mm-dd hh:mm' }
              : {},
    }));
    this.sheet.getRow(1).font = { bold: true };
  }

  write(rows: Row[]) {
    for (const row of rows) {
      this.sheet
        .addRow(
          Object.fromEntries(
            this.columns.map((c) => [
              c.key,
              c.type === 'datetime' && row[c.key]
                ? new Date(asText(row[c.key]))
                : row[c.key],
            ]),
          ),
        )
        .commit();
    }
    return Promise.resolve();
  }

  async end(totals: Row) {
    if (Object.keys(totals).length > 0) {
      const totalRow = this.sheet.addRow({
        [this.columns[0].key]: 'Total',
        ...totals,
      });
      totalRow.font = { bold: true };
      totalRow.commit();
    }
    this.sheet.commit();
    await this.workbook.commit();
  }
}

// ---- PDF ----

const PAGE_MARGIN = 36;

// Relative column widths in PDFs
const columnWeight = (c: ReportColumn) =>
  c.type === 'text' ? 2 : c.type === 'datetime' ? 1.8 : 1.2;

/** Value as printed in a PDF cell */
export function pdfCell(
  column: ReportColumn,
  value: unknown,
  timezone: string,
  rowCurrency?: unknown,
): string {
  if (value === null || value === undefined || value === '') return '';
  switch (column.type) {
    case 'money': {
      const amount = Number(value).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      return typeof rowCurrency === 'string' && rowCurrency
        ? `${amount} ${rowCurrency}`
        : amount;
    }
    case 'percent':
      return `${(Number(value) * 100).toFixed(1)}%`;
    case 'number':
      return Number(value).toLocaleString('en-US', {
        maximumFractionDigits: 4,
      });
    case 'datetime':
      try {
        return new Intl.DateTimeFormat('en-GB', {
          timeZone: timezone,
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(new Date(asText(value)));
      } catch {
        return asText(value);
      }
    default:
      return asText(value);
  }
}

const formatStamp = (value: string | Date | null, timezone: string) => {
  if (!value) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return new Date(value).toISOString();
  }
};

/** Title block: store, branch, period, generated at, currency */
export function pdfHeader(doc: PDFKit.PDFDocument, header: ReportFileHeader) {
  const tz = header.period.timezone;
  doc.font('Helvetica-Bold').fontSize(14).text(header.title);
  doc.font('Helvetica').fontSize(8).fillColor('#444444');
  if (header.description) doc.text(header.description);
  const lines = [
    `Store: ${header.storeName}`,
    `Branch: ${header.branches.length > 0 ? header.branches.join(', ') : 'All branches'}`,
    header.period.from || header.period.to
      ? `Period: ${formatStamp(header.period.from, tz)} – ${formatStamp(header.period.to, tz)} (${tz})`
      : `As of: ${formatStamp(header.generatedAt, tz)} (${tz})`,
    `Generated: ${formatStamp(header.generatedAt, tz)}`,
    `Currency: ${header.currency ?? 'per row (amounts in different currencies are never added together)'}`,
  ];
  doc.text(lines.join('   ·   '));
  doc.fillColor('#000000').moveDown(0.6);
}

/** A small, complete table (daily summary sections); repeats its header on new pages */
export function pdfTable(
  doc: PDFKit.PDFDocument,
  columns: ReportColumn[],
  rows: Row[],
  timezone: string,
) {
  const usable = doc.page.width - PAGE_MARGIN * 2;
  const weight = columnWeight;
  const sum = columns.reduce((s, c) => s + weight(c), 0) || 1;
  const widths = columns.map((c) => (usable * weight(c)) / sum);
  const line = (cells: string[], bold: boolean) => {
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(8);
    const height =
      Math.max(
        10,
        ...cells.map((cell, i) =>
          doc.heightOfString(cell, { width: widths[i] - 4 }),
        ),
      ) + 3;
    if (doc.y + height > doc.page.height - PAGE_MARGIN) {
      doc.addPage();
      if (!bold)
        line(
          columns.map((c) => c.label),
          true,
        );
      doc.font('Helvetica').fontSize(8);
    }
    const y = doc.y;
    let x = PAGE_MARGIN;
    cells.forEach((cell, i) => {
      doc.text(cell, x + 2, y + 1, {
        width: widths[i] - 4,
        align: ['money', 'number', 'percent'].includes(columns[i].type)
          ? 'right'
          : 'left',
      });
      x += widths[i];
    });
    doc
      .moveTo(PAGE_MARGIN, y + height)
      .lineTo(doc.page.width - PAGE_MARGIN, y + height)
      .lineWidth(bold ? 0.8 : 0.2)
      .strokeColor('#999999')
      .stroke();
    doc.x = PAGE_MARGIN;
    doc.y = y + height + 1;
  };
  line(
    columns.map((c) => c.label),
    true,
  );
  if (rows.length === 0) {
    doc.font('Helvetica-Oblique').fontSize(8).text('None', PAGE_MARGIN);
  }
  for (const row of rows) {
    line(
      columns.map((c) =>
        pdfCell(c, row[c.key], timezone, row[CURRENCY_COLUMN]),
      ),
      false,
    );
  }
  doc.moveDown(0.8);
}

/** Section title in a multi-table PDF */
export function pdfSection(doc: PDFKit.PDFDocument, title: string) {
  if (doc.y + 60 > doc.page.height - PAGE_MARGIN) doc.addPage();
  doc.font('Helvetica-Bold').fontSize(11).text(title, PAGE_MARGIN);
  doc.moveDown(0.3);
}

/** Build a PDF in memory */
export async function pdfBuffer(
  build: (doc: PDFKit.PDFDocument) => void,
  title: string,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: PAGE_MARGIN,
    info: { Title: title, Producer: 'POS reports' },
  });
  const sink = bufferSink();
  doc.pipe(sink.stream);
  build(doc);
  doc.end();
  await finished(sink.stream);
  return sink.buffer();
}

class PdfWriter implements ReportFileWriter {
  private doc: PDFKit.PDFDocument;
  private widths: number[];
  private written = 0;
  private truncated = false;
  private done: Promise<void>;

  constructor(
    out: Writable,
    private columns: ReportColumn[],
    private header: ReportFileHeader,
  ) {
    this.doc = new PDFDocument({
      size: 'A4',
      layout: columns.length > 6 ? 'landscape' : 'portrait',
      margin: PAGE_MARGIN,
      bufferPages: false,
      info: { Title: header.title, Producer: 'POS reports' },
    });
    this.done = new Promise((resolve, reject) => {
      out.once('finish', () => resolve());
      out.once('error', reject);
    });
    this.doc.pipe(out);
    const usable = this.doc.page.width - PAGE_MARGIN * 2;
    const weight = columnWeight;
    const sum = columns.reduce((s, c) => s + weight(c), 0) || 1;
    this.widths = columns.map((c) => (usable * weight(c)) / sum);
    pdfHeader(this.doc, header);
    this.tableHeader();
  }

  private tableHeader() {
    this.line(
      this.columns.map((c) => c.label),
      true,
    );
  }

  private line(cells: string[], bold = false) {
    const doc = this.doc;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7);
    const heights = cells.map((cell, i) =>
      doc.heightOfString(cell, { width: this.widths[i] - 4 }),
    );
    const height = Math.max(9, ...heights) + 3;
    if (doc.y + height > doc.page.height - PAGE_MARGIN) {
      doc.addPage();
      if (!bold) this.tableHeader();
      doc.font('Helvetica').fontSize(7);
    }
    const y = doc.y;
    let x = PAGE_MARGIN;
    cells.forEach((cell, i) => {
      const numeric = ['money', 'number', 'percent'].includes(
        this.columns[i]?.type,
      );
      doc.text(cell, x + 2, y + 1, {
        width: this.widths[i] - 4,
        align: numeric ? 'right' : 'left',
        lineBreak: true,
      });
      x += this.widths[i];
    });
    doc
      .moveTo(PAGE_MARGIN, y + height)
      .lineTo(doc.page.width - PAGE_MARGIN, y + height)
      .lineWidth(bold ? 0.8 : 0.2)
      .strokeColor('#999999')
      .stroke();
    doc.x = PAGE_MARGIN;
    doc.y = y + height + 1;
  }

  write(rows: Row[]) {
    for (const row of rows) {
      if (this.written >= PDF_MAX_ROWS) {
        this.truncated = true;
        break;
      }
      this.line(
        this.columns.map((c) =>
          pdfCell(
            c,
            row[c.key],
            this.header.period.timezone,
            row[CURRENCY_COLUMN],
          ),
        ),
      );
      this.written++;
    }
    return Promise.resolve();
  }

  async end(totals: Row, mixedCurrencies: boolean) {
    if (this.written === 0) {
      this.doc.font('Helvetica').fontSize(9).text('No data for this period.');
    }
    if (!this.truncated && Object.keys(totals).length > 0) {
      this.line(
        this.columns.map((c, i) =>
          i === 0
            ? 'Total'
            : c.key in totals
              ? pdfCell(
                  c,
                  totals[c.key],
                  this.header.period.timezone,
                  mixedCurrencies ? null : this.header.currency,
                )
              : '',
        ),
        true,
      );
    }
    if (this.truncated) {
      this.doc
        .moveDown()
        .font('Helvetica-Oblique')
        .fontSize(8)
        .text(
          `Only the first ${PDF_MAX_ROWS} rows are printed. Export as CSV or Excel for every row.`,
        );
    }
    if (mixedCurrencies) {
      this.doc
        .moveDown(0.5)
        .font('Helvetica-Oblique')
        .fontSize(8)
        .text(
          'Amounts are in several currencies: money columns are not totalled.',
        );
    }
    this.doc.end();
    await this.done;
  }
}

export function createReportWriter(
  format: ReportFileFormat,
  out: Writable,
  columns: ReportColumn[],
  header: ReportFileHeader,
): ReportFileWriter {
  switch (format) {
    case 'csv':
      return new CsvWriter(out, columns);
    case 'xlsx':
      return new XlsxWriter(out, columns, header.title);
    case 'pdf':
      return new PdfWriter(out, columns, header);
  }
}

/** A writable that collects everything written to it into one Buffer */
export function bufferSink(): { stream: Writable; buffer: () => Buffer } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, buffer: () => Buffer.concat(chunks) };
}

/** Whole report (already in memory) → file Buffer */
export async function reportFile(
  format: ReportFileFormat,
  columns: ReportColumn[],
  header: ReportFileHeader,
  rows: Row[],
  totals: Row,
  mixedCurrencies: boolean,
): Promise<Buffer> {
  const sink = bufferSink();
  const writer = createReportWriter(format, sink.stream, columns, header);
  await writer.write(rows);
  await writer.end(totals, mixedCurrencies);
  await finished(sink.stream);
  return sink.buffer();
}
