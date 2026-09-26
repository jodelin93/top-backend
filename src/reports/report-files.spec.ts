import type { ReportColumn } from './report-definitions';
import {
  csvCell,
  pdfBuffer,
  pdfTable,
  reportFile,
  ReportFileHeader,
  TotalsAccumulator,
} from './report-files';

const columns: ReportColumn[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'currency', label: 'Currency', type: 'text' },
  { key: 'saleCount', label: 'Sales', type: 'number', total: true },
  { key: 'netSales', label: 'Net sales', type: 'money', total: true },
  { key: 'at', label: 'At', type: 'datetime' },
];
const header: ReportFileHeader = {
  title: 'Sales by day',
  description: 'Daily sales',
  storeName: 'Chez Marie',
  branches: ['Pétion-Ville'],
  period: {
    from: '2026-09-01T04:00:00Z',
    to: '2026-09-02T03:59:59Z',
    timezone: 'America/Port-au-Prince',
  },
  generatedAt: new Date('2026-09-02T12:00:00Z'),
  currency: 'USD',
};
const rows = [
  {
    date: '2026-09-01',
    currency: 'USD',
    saleCount: 3,
    netSales: 120.5,
    at: '2026-09-01T15:00:00Z',
  },
  {
    date: '2026-09-01',
    currency: 'USD',
    saleCount: 1,
    netSales: 9.5,
    at: null,
  },
];

describe('report files', () => {
  it('builds a valid PDF with header and table', async () => {
    const { totals, mixedCurrencies } = (() => {
      const acc = new TotalsAccumulator(columns);
      acc.add(rows);
      return acc.result();
    })();
    const pdf = await reportFile(
      'pdf',
      columns,
      header,
      rows,
      totals,
      mixedCurrencies,
    );
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.subarray(-6).toString()).toContain('%%EOF');
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it('builds a multi-section PDF (daily summary)', async () => {
    const pdf = await pdfBuffer((doc) => {
      pdfTable(doc, columns, rows, 'UTC');
      pdfTable(doc, columns, [], 'UTC');
    }, 'Daily summary');
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('builds CSV with a totals row and Excel as a zip', async () => {
    const csv = (
      await reportFile(
        'csv',
        columns,
        header,
        rows,
        { saleCount: 4, netSales: 130 },
        false,
      )
    ).toString('utf8');
    expect(csv.startsWith('﻿Date,Currency,Sales')).toBe(true);
    expect(csv.trim().split('\r\n').pop()).toBe('Total,,4,130,');
    const xlsx = await reportFile('xlsx', columns, header, rows, {}, false);
    expect(xlsx.subarray(0, 2).toString()).toBe('PK');
  });

  it('neutralises spreadsheet formulas', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('a,b')).toBe('"a,b"');
  });

  it('never totals money across currencies', () => {
    const acc = new TotalsAccumulator(columns);
    acc.add([rows[0]]);
    acc.add([{ ...rows[1], currency: 'HTG' }]);
    expect(acc.result()).toEqual({
      totals: { saleCount: 4 },
      mixedCurrencies: true,
    });
    expect(acc.currency).toBeNull();
  });
});
