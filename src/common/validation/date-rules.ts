import { BadRequestException } from '@nestjs/common';
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { EntityManager } from 'typeorm';
import { Branch } from '../../database/entities/branch.entity';

/**
 * Date rules shared by the DTOs and the services.
 *
 * Two kinds of values reach the API:
 * - date-only strings (YYYY-MM-DD): a calendar day in the store's time zone;
 * - timestamps (ISO 8601 with a time): an instant.
 *
 * A DTO does not know the store's time zone, so the decorators below accept
 * any day that is "today" somewhere on Earth (UTC-12 … UTC+14). The services
 * then check calendar-day rules precisely against the branch time zone with
 * assertNotFutureDay / assertNotPastDay.
 */

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Clock skew tolerated between a device and the server for timestamps */
export const CLOCK_SKEW_MS = 5 * 60_000;

// Earliest and latest civil time zones: every "today" on Earth is between them
const EARLIEST_ZONE = 'Etc/GMT+12';
const LATEST_ZONE = 'Etc/GMT-14';

export const MESSAGES = {
  future: 'The date cannot be in the future',
  past: 'The date cannot be in the past',
  range: 'The start date is after the end date',
  tooOld: 'The date cannot be before 1900',
} as const;

export function isDateOnly(value: unknown): value is string {
  return typeof value === 'string' && DATE_ONLY.test(value);
}

/** YYYY-MM-DD of an instant in a time zone (UTC when the zone is unknown) */
export function dayIn(at: Date, timezone: string | null | undefined): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/** Today's calendar date in the time zone */
export function todayIn(
  timezone: string | null | undefined,
  now = new Date(),
): string {
  return dayIn(now, timezone);
}

/** Calendar day of a value: itself when date-only, else its day in the zone */
export function dayOf(
  value: string | Date,
  timezone: string | null | undefined,
): string | null {
  if (isDateOnly(value)) return value;
  const at = value instanceof Date ? value : new Date(value);
  return Number.isNaN(at.getTime()) ? null : dayIn(at, timezone);
}

/** Adds days to a YYYY-MM-DD date */
export function addDays(day: string, days: number): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * Compares two date values: -1, 0 or 1 (null when one is missing or invalid).
 * When either is date-only the comparison is by calendar day.
 */
export function compareDates(a: unknown, b: unknown): number | null {
  if (a == null || b == null || a === '' || b === '') return null;
  if (!(typeof a === 'string' || a instanceof Date)) return null;
  if (!(typeof b === 'string' || b instanceof Date)) return null;
  if (isDateOnly(a) || isDateOnly(b)) {
    const da = isDateOnly(a) ? a : dayOf(a, 'UTC');
    const db = isDateOnly(b) ? b : dayOf(b, 'UTC');
    if (!da || !db) return null;
    return da < db ? -1 : da > db ? 1 : 0;
  }
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return ta < tb ? -1 : ta > tb ? 1 : 0;
}

/** Not after today anywhere on Earth (date-only) / not after now (timestamps) */
export function isNotFutureAnywhere(value: unknown, now = new Date()): boolean {
  if (value == null || value === '') return true;
  if (typeof value !== 'string') return false;
  if (isDateOnly(value)) return value <= todayIn(LATEST_ZONE, now);
  const at = new Date(value).getTime();
  return !Number.isNaN(at) && at <= now.getTime() + CLOCK_SKEW_MS;
}

/** Not before today anywhere on Earth (date-only) / not before now (timestamps) */
export function isNotPastAnywhere(value: unknown, now = new Date()): boolean {
  if (value == null || value === '') return true;
  if (typeof value !== 'string') return false;
  if (isDateOnly(value)) return value >= todayIn(EARLIEST_ZONE, now);
  const at = new Date(value).getTime();
  return !Number.isNaN(at) && at >= now.getTime() - CLOCK_SKEW_MS;
}

function decorator(
  name: string,
  test: (value: unknown, args: ValidationArguments) => boolean,
  message: string,
  options?: ValidationOptions,
  constraints: unknown[] = [],
) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name,
      target: object.constructor,
      propertyName,
      constraints,
      options: { message, ...options },
      validator: { validate: test },
    });
}

/** The date is not in the future (see isNotFutureAnywhere) */
export function IsNotFutureDate(options?: ValidationOptions) {
  return decorator(
    'isNotFutureDate',
    (value) => isNotFutureAnywhere(value),
    MESSAGES.future,
    options,
  );
}

/** The date is not in the past (see isNotPastAnywhere) */
export function IsNotPastDate(options?: ValidationOptions) {
  return decorator(
    'isNotPastDate',
    (value) => isNotPastAnywhere(value),
    MESSAGES.past,
    options,
  );
}

/** The date is on or after another field of the same object (when both are set) */
export function IsOnOrAfterField(field: string, options?: ValidationOptions) {
  return decorator(
    'isOnOrAfterField',
    (value, args) => {
      const other = (args.object as Record<string, unknown>)[field];
      const order = compareDates(value, other);
      return order === null || order >= 0;
    },
    MESSAGES.range,
    options,
    [field],
  );
}

/** The date is on or after a fixed day (YYYY-MM-DD) */
export function IsNotBeforeDay(day: string, options?: ValidationOptions) {
  return decorator(
    'isNotBeforeDay',
    (value) => {
      const order = compareDates(value, day);
      return order === null || order >= 0;
    },
    MESSAGES.tooOld,
    options,
    [day],
  );
}

/** from ≤ to, as a 400 */
export function assertDateRange(
  from: unknown,
  to: unknown,
  message: string = MESSAGES.range,
): void {
  const order = compareDates(from, to);
  if (order !== null && order > 0) throw new BadRequestException(message);
}

/** The calendar day of the value is not after today in the store's zone */
export function assertNotFutureDay(
  value: string | Date | null | undefined,
  timezone: string | null | undefined,
  message: string = MESSAGES.future,
  now = new Date(),
): void {
  if (value == null || value === '') return;
  const day = dayOf(value, timezone);
  if (day && day > todayIn(timezone, now)) {
    throw new BadRequestException(message);
  }
}

/** The calendar day of the value is not before today in the store's zone */
export function assertNotPastDay(
  value: string | Date | null | undefined,
  timezone: string | null | undefined,
  message: string = MESSAGES.past,
  now = new Date(),
): void {
  if (value == null || value === '') return;
  const day = dayOf(value, timezone);
  if (day && day < todayIn(timezone, now)) {
    throw new BadRequestException(message);
  }
}

/**
 * Time zone of the store for calendar-day rules: the branch's, else the
 * store's first branch (stores without branches fall back to UTC).
 */
export async function storeTimezone(
  manager: EntityManager,
  tenantId: string,
  branchId?: string | null,
): Promise<string> {
  const repo = manager.getRepository(Branch);
  const branch = branchId
    ? await repo.findOne({
        where: { id: branchId, tenantId },
        select: { id: true, timezone: true },
      })
    : null;
  if (branch?.timezone) return branch.timezone;
  const first = await repo.findOne({
    where: { tenantId },
    select: { id: true, timezone: true },
    order: { createdAt: 'ASC' },
  });
  return first?.timezone || 'UTC';
}

type Moment = unknown;

/**
 * Validity window of a discount or price list (timestamps from the admin's
 * date-time pickers): the end is not before the start, and a new or changed
 * end is not already over.
 */
export function assertValidityWindow(
  patch: { validFrom?: Moment; validTo?: Moment },
  current?: { validFrom?: Moment; validTo?: Moment } | null,
  now = new Date(),
): void {
  const from =
    patch.validFrom !== undefined ? patch.validFrom : current?.validFrom;
  const to = patch.validTo !== undefined ? patch.validTo : current?.validTo;
  assertDateRange(from, to);
  const newTo = patch.validTo;
  if (newTo == null || newTo === '') return;
  // Same minute as the stored end: the form sends it back unchanged
  const unchanged =
    current?.validTo != null &&
    Math.abs(
      new Date(newTo as string | Date).getTime() -
        new Date(current.validTo as string | Date).getTime(),
    ) < 60_000;
  const value =
    newTo instanceof Date
      ? newTo.toISOString()
      : typeof newTo === 'string'
        ? newTo
        : null;
  if (!unchanged && !isNotPastAnywhere(value, now)) {
    throw new BadRequestException('The end date cannot be in the past');
  }
}

/** The date is at most `days` days after today (anywhere on Earth) */
export function IsWithinDaysAhead(days: number, options?: ValidationOptions) {
  return decorator(
    'isWithinDaysAhead',
    (value) => {
      if (value == null || value === '') return true;
      const day = dayOf(value as string, 'UTC');
      return !!day && day <= addDays(todayIn(LATEST_ZONE), days);
    },
    'The date is too far in the future',
    options,
    [days],
  );
}

/** Longest attendance record accepted (a forgotten clock-out is closed by hand) */
export const MAX_SHIFT_MS = 24 * 3_600_000;

export function assertShiftLength(clockIn: Date, clockOut: Date | null): void {
  if (!clockOut) return;
  if (clockOut.getTime() < clockIn.getTime()) {
    throw new BadRequestException('The clock-out is before the clock-in');
  }
  if (clockOut.getTime() - clockIn.getTime() > MAX_SHIFT_MS) {
    throw new BadRequestException('A shift cannot last more than 24 hours');
  }
}
