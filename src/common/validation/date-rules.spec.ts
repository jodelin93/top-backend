import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  addDays,
  assertDateRange,
  assertNotFutureDay,
  assertNotPastDay,
  assertShiftLength,
  assertValidityWindow,
  compareDates,
  dayOf,
  IsNotBeforeDay,
  IsNotFutureDate,
  IsNotPastDate,
  IsOnOrAfterField,
  IsWithinDaysAhead,
  isNotFutureAnywhere,
  isNotPastAnywhere,
  todayIn,
} from './date-rules';

class Sample {
  @IsNotFutureDate() spent?: string;
  @IsNotPastDate() effective?: string;
  from?: string;
  @IsOnOrAfterField('from') to?: string;
  @IsNotBeforeDay('1900-01-01') born?: string;
  @IsWithinDaysAhead(366) hired?: string;
}

const errors = (plain: Partial<Sample>) =>
  validateSync(plainToInstance(Sample, plain)).map((e) => e.property);

describe('date rules', () => {
  // 2026-03-10 02:30 UTC = 2026-03-09 21:30 in Port-au-Prince (UTC-5)
  const now = new Date('2026-03-10T02:30:00Z');
  const haiti = 'America/Port-au-Prince';

  it('computes today in the store time zone, not UTC', () => {
    expect(todayIn('UTC', now)).toBe('2026-03-10');
    expect(todayIn(haiti, now)).toBe('2026-03-09');
    expect(todayIn('Not/AZone', now)).toBe('2026-03-10');
  });

  it('keeps date-only values as calendar days', () => {
    expect(dayOf('2026-03-09', 'Asia/Tokyo')).toBe('2026-03-09');
    expect(dayOf('2026-03-10T02:30:00Z', haiti)).toBe('2026-03-09');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('compares date-only values by day', () => {
    expect(compareDates('2026-03-09', '2026-03-09T23:00:00Z')).toBe(0);
    expect(compareDates('2026-03-08', '2026-03-09')).toBe(-1);
    expect(compareDates(null, '2026-03-09')).toBeNull();
  });

  it('rejects a future calendar day in the store zone', () => {
    // Tomorrow for Haiti although it is already "today" in UTC
    expect(() =>
      assertNotFutureDay('2026-03-10', haiti, undefined, now),
    ).toThrow(BadRequestException);
    expect(() =>
      assertNotFutureDay('2026-03-09', haiti, undefined, now),
    ).not.toThrow();
    expect(() => assertNotFutureDay(null, haiti)).not.toThrow();
  });

  it('rejects a past calendar day in the store zone', () => {
    expect(() => assertNotPastDay('2026-03-08', haiti, undefined, now)).toThrow(
      'The date cannot be in the past',
    );
    expect(() =>
      assertNotPastDay('2026-03-09', haiti, undefined, now),
    ).not.toThrow();
  });

  it('accepts any day that is today somewhere on Earth at the DTO level', () => {
    expect(isNotFutureAnywhere('2026-03-10', now)).toBe(true);
    expect(isNotFutureAnywhere('2026-03-12', now)).toBe(false);
    expect(isNotPastAnywhere('2026-03-09', now)).toBe(true);
    expect(isNotPastAnywhere('2026-03-07', now)).toBe(false);
    // Timestamps: 5 minutes of clock skew
    expect(isNotFutureAnywhere('2026-03-10T02:33:00Z', now)).toBe(true);
    expect(isNotFutureAnywhere('2026-03-10T03:00:00Z', now)).toBe(false);
  });

  it('validates DTO fields', () => {
    expect(errors({ spent: '2999-01-01' })).toEqual(['spent']);
    expect(errors({ effective: '2000-01-01' })).toEqual(['effective']);
    expect(errors({ from: '2026-03-10', to: '2026-03-09' })).toEqual(['to']);
    expect(errors({ from: '2026-03-10', to: '2026-03-10' })).toEqual([]);
    expect(errors({ to: '2026-03-09' })).toEqual([]);
    expect(errors({ born: '1899-12-31' })).toEqual(['born']);
    expect(errors({ hired: '2999-01-01' })).toEqual(['hired']);
    expect(errors({ hired: todayIn('UTC') })).toEqual([]);
  });

  it('checks ranges, validity windows and shift length', () => {
    expect(() => assertDateRange('2026-03-10', '2026-03-09')).toThrow(
      'The start date is after the end date',
    );
    expect(() => assertDateRange('2026-03-09', undefined)).not.toThrow();
    expect(() =>
      assertValidityWindow({ validTo: '2020-01-01T00:00:00Z' }),
    ).toThrow('The end date cannot be in the past');
    // Unchanged past end date: editing another field still works
    expect(() =>
      assertValidityWindow(
        { validTo: '2020-01-01T00:00:00.000Z' },
        { validTo: new Date('2020-01-01T00:00:00Z') },
      ),
    ).not.toThrow();
    expect(() =>
      assertValidityWindow(
        { validFrom: '2999-02-01T00:00:00Z' },
        { validTo: '2999-01-01T00:00:00Z' },
      ),
    ).toThrow('The start date is after the end date');
    const start = new Date('2026-03-09T08:00:00Z');
    expect(() =>
      assertShiftLength(start, new Date('2026-03-09T07:00:00Z')),
    ).toThrow('The clock-out is before the clock-in');
    expect(() =>
      assertShiftLength(start, new Date('2026-03-10T09:00:00Z')),
    ).toThrow('A shift cannot last more than 24 hours');
    expect(() =>
      assertShiftLength(start, new Date('2026-03-09T17:00:00Z')),
    ).not.toThrow();
  });
});
