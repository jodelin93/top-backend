/**
 * Business (trading) date of a moment: the calendar date in the branch timezone,
 * where the day starts at `cutoffHour` instead of midnight. With cutoffHour 4,
 * a sale at 02:30 local time belongs to the previous day.
 *
 * The same rule runs in the database (pos_business_date(), used by the trigger
 * that stamps sales."businessDate"); keep both in step.
 */
export function businessDateOf(
  at: Date,
  timezone: string | null | undefined,
  cutoffHour = 0,
): string {
  const hours = clampCutoff(cutoffHour);
  const shifted = new Date(at.getTime() - hours * 3_600_000);
  return localDate(shifted, timezone || 'UTC');
}

export function clampCutoff(value: unknown): number {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, 23);
}

/** YYYY-MM-DD of the instant in the timezone (UTC when the zone is unknown) */
function localDate(at: Date, timezone: string): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
