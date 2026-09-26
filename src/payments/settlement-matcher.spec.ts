import { BadRequestException } from '@nestjs/common';
import {
  matchSettlement,
  normalizeSettlementRows,
  parseSettlementCsv,
} from './settlement-matcher';

const payment = (
  id: string,
  amount: number,
  refs: string[],
  day = '2026-09-20',
) => ({
  id,
  amount,
  references: refs,
  paidAt: new Date(`${day}T15:00:00Z`),
});
const line = (reference: string, amount: number, date = '2026-09-21') => ({
  reference,
  amount,
  fee: 0,
  date,
});

describe('matchSettlement', () => {
  it('matches by reference and amount, case-insensitively', () => {
    const result = matchSettlement(
      [line('MOCK_ABC', 20), line('auth-9', 5)],
      [payment('p1', 20, ['mock_abc']), payment('p2', 5, ['AUTH-9'])],
    );
    expect(result.map((r) => r.paymentId)).toEqual(['p1', 'p2']);
  });

  it('leaves a reference with a different amount unmatched, with a note', () => {
    const [result] = matchSettlement(
      [line('ref-1', 19)],
      [payment('p1', 20, ['ref-1'])],
    );
    expect(result.paymentId).toBeNull();
    expect(result.note).toContain('amount differs');
  });

  it('never matches one payment twice', () => {
    const result = matchSettlement(
      [line('ref-1', 20), line('ref-1', 20)],
      [payment('p1', 20, ['ref-1'])],
    );
    expect(result.map((r) => r.paymentId)).toEqual(['p1', null]);
  });

  it('matches a line without reference by a unique amount near the date', () => {
    const result = matchSettlement(
      [line('', 42.5)],
      [payment('p1', 42.5, []), payment('p2', 42.5, [], '2026-08-01')],
    );
    expect(result[0]).toEqual({ paymentId: 'p1', note: 'Matched by amount' });
  });

  it('refuses to guess between payments of the same amount', () => {
    const [result] = matchSettlement(
      [line('', 10)],
      [payment('p1', 10, []), payment('p2', 10, [])],
    );
    expect(result.paymentId).toBeNull();
    expect(result.note).toContain('2 payments');
  });
});

describe('settlement parsing', () => {
  it('reads CSV with common column names', () => {
    const lines = parseSettlementCsv(
      '﻿Transaction ID,Gross,Fee,Settled Date\nmock_1,"1,020.50",2.10,2026-09-21\n',
    );
    expect(lines).toEqual([
      { reference: 'mock_1', amount: 1020.5, fee: 2.1, date: '2026-09-21' },
    ]);
  });

  it('rejects rows without an amount or with bad numbers', () => {
    expect(() => normalizeSettlementRows([{ reference: 'x' }])).toThrow(
      'Row 1: amount is missing',
    );
    expect(() => normalizeSettlementRows([{ amount: 'abc' }])).toThrow(
      BadRequestException,
    );
    expect(() => normalizeSettlementRows([])).toThrow('no rows');
    // Strict amounts: no digits glued together from junk, no exponent, 2 decimals
    for (const amount of [
      '12abc34',
      '1.2.3',
      '1e9',
      '10.505',
      '--5',
      '1,2,3',
    ]) {
      expect(() => normalizeSettlementRows([{ amount }])).toThrow(
        BadRequestException,
      );
    }
    expect(() => normalizeSettlementRows([{ amount: '99999999999' }])).toThrow(
      BadRequestException,
    );
  });

  it('accepts currency symbols, thousands separators and negatives', () => {
    const lines = normalizeSettlementRows([
      { amount: '$1,020.50', fee: 'HTG 2.1', reference: 'r'.repeat(300) },
      { amount: '-5.00' },
      { amount: 12.5 },
    ]);
    expect(lines.map((l) => l.amount)).toEqual([1020.5, -5, 12.5]);
    expect(lines[0].fee).toBe(2.1);
    expect(lines[0].reference).toHaveLength(255);
  });
});
