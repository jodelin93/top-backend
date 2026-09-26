import { BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { MAX_MONEY } from '../common/validation/money';

/**
 * Card settlement reconciliation (R056): pure parsing and matching.
 */

export interface SettlementInputLine {
  reference: string;
  amount: number;
  fee: number;
  // YYYY-MM-DD
  date: string | null;
}

export interface MatchCandidate {
  id: string;
  // Provider reference and/or terminal approval code
  references: string[];
  amount: number;
  paidAt: Date;
}

export interface LineMatch {
  paymentId: string | null;
  note: string | null;
}

const norm = (value: string) => value.trim().toLowerCase();
const sameAmount = (a: number, b: number) => Math.abs(a - b) < 0.005;
const DAY_MS = 24 * 60 * 60 * 1000;
// A settlement line without a reference may match a payment this many days apart
const AMOUNT_MATCH_WINDOW_DAYS = 3;

/**
 * Match each settlement line to at most one payment, and each payment to at most one line:
 * 1. same reference (provider reference or approval code) and same amount
 * 2. line without a reference: the only unmatched payment with the same amount within
 *    ±3 days of the settlement date (ambiguous amounts stay unmatched for a person to decide)
 * A reference that matches with a different amount is left unmatched with a note.
 */
export function matchSettlement(
  lines: SettlementInputLine[],
  candidates: MatchCandidate[],
): LineMatch[] {
  const used = new Set<string>();
  const byReference = new Map<string, MatchCandidate[]>();
  for (const candidate of candidates) {
    for (const ref of candidate.references.filter(Boolean)) {
      const key = norm(ref);
      byReference.set(key, [...(byReference.get(key) ?? []), candidate]);
    }
  }

  const results: LineMatch[] = lines.map(() => ({
    paymentId: null,
    note: null,
  }));

  // Pass 1: by reference
  lines.forEach((line, index) => {
    if (!line.reference.trim()) return;
    const found = (byReference.get(norm(line.reference)) ?? []).filter(
      (c) => !used.has(c.id),
    );
    const exact = found.find((c) => sameAmount(c.amount, line.amount));
    if (exact) {
      used.add(exact.id);
      results[index] = { paymentId: exact.id, note: null };
    } else if (found.length > 0) {
      results[index] = {
        paymentId: null,
        note: `Reference found but the amount differs (payment ${found[0].amount.toFixed(2)})`,
      };
    }
  });

  // Pass 2: lines without a reference, by unique amount near the settlement date
  lines.forEach((line, index) => {
    if (line.reference.trim() || results[index].paymentId) return;
    const settled = line.date ? new Date(`${line.date}T12:00:00Z`) : null;
    const options = candidates.filter(
      (c) =>
        !used.has(c.id) &&
        sameAmount(c.amount, line.amount) &&
        (!settled ||
          Math.abs(c.paidAt.getTime() - settled.getTime()) <=
            AMOUNT_MATCH_WINDOW_DAYS * DAY_MS),
    );
    if (options.length === 1) {
      used.add(options[0].id);
      results[index] = { paymentId: options[0].id, note: 'Matched by amount' };
    } else if (options.length > 1) {
      results[index] = {
        paymentId: null,
        note: `${options.length} payments have this amount; match it by hand`,
      };
    }
  });

  return results;
}

const ALIASES: Record<keyof SettlementInputLine, string[]> = {
  reference: [
    'reference',
    'ref',
    'transaction_id',
    'transaction id',
    'transactionid',
    'approval_code',
    'approval code',
    'id',
  ],
  amount: ['amount', 'gross', 'gross_amount', 'gross amount', 'total'],
  fee: ['fee', 'fees', 'commission'],
  date: [
    'date',
    'settled_date',
    'settled date',
    'settlement_date',
    'settlement date',
    'settled',
    'settled at',
  ],
};

// Cell values from CSV (strings) or JSON (strings/numbers)
const cell = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

const AMOUNT = /^-?\d+(\.\d{1,2})?$/;
const THOUSANDS = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;
const MAX_REFERENCE_LENGTH = 255;

/**
 * Strict money parsing: optional currency symbol/code (e.g. "$", "HTG") around
 * the number, "," only as a thousands separator, at most 2 decimals. Anything
 * else ("12abc34", "1.2.3", "1e9") is rejected rather than guessed at.
 */
function toAmount(value: unknown, field: string, row: number): number {
  if (value === undefined || value === null || value === '') return 0;
  let text = cell(value)
    .trim()
    .replace(/^(-?)\s*[^\d\s.,-]{1,3}\s*/, '$1')
    .replace(/\s*[^\d\s.,-]{1,3}$/, '');
  if (THOUSANDS.test(text)) text = text.replace(/,/g, '');
  const n = Number(text);
  if (!AMOUNT.test(text) || !Number.isFinite(n) || Math.abs(n) > MAX_MONEY) {
    throw new BadRequestException(
      `Row ${row}: ${field} "${cell(value).slice(0, 50)}" is not a valid amount`,
    );
  }
  return Math.round(n * 100) / 100;
}

function toDate(value: unknown, row: number): string | null {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(cell(value));
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(
      `Row ${row}: date "${cell(value)}" is not a date`,
    );
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Normalise rows from a CSV file or a JSON body
 */
export function normalizeSettlementRows(
  rows: Record<string, unknown>[],
): SettlementInputLine[] {
  if (rows.length === 0) {
    throw new BadRequestException('The settlement file has no rows');
  }
  if (rows.length > 10000) {
    throw new BadRequestException('At most 10,000 rows per settlement batch');
  }
  const pick = (
    row: Record<string, unknown>,
    field: keyof SettlementInputLine,
  ) => {
    const key = Object.keys(row).find((k) =>
      ALIASES[field].includes(k.trim().toLowerCase()),
    );
    return key === undefined ? undefined : row[key];
  };
  return rows.map((row, i) => {
    const line = i + 1;
    const amountValue = pick(row, 'amount');
    if (amountValue === undefined || amountValue === '') {
      throw new BadRequestException(`Row ${line}: amount is missing`);
    }
    const reference = pick(row, 'reference');
    return {
      reference: cell(reference).trim().slice(0, MAX_REFERENCE_LENGTH),
      amount: toAmount(amountValue, 'amount', line),
      fee: toAmount(pick(row, 'fee'), 'fee', line),
      date: toDate(pick(row, 'date'), line),
    };
  });
}

export function parseSettlementCsv(content: string): SettlementInputLine[] {
  let rows: Record<string, string>[];
  try {
    rows = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (error) {
    throw new BadRequestException(
      `Could not read the CSV file: ${(error as Error).message}`,
    );
  }
  return normalizeSettlementRows(rows);
}
