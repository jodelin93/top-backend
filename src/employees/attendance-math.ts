/**
 * Worked hours from clock-in / clock-out records (pure, unit tested).
 * An open record (still clocked in) counts up to `now` but is flagged open;
 * records are clipped to the report window.
 */
export interface AttendanceSpan {
  clockIn: Date | string;
  clockOut: Date | string | null;
}

export function spanHours(
  span: AttendanceSpan,
  window: { from: Date; to: Date },
  now: Date = new Date(),
): number {
  const start = Math.max(
    new Date(span.clockIn).getTime(),
    window.from.getTime(),
  );
  const endRaw = span.clockOut ? new Date(span.clockOut) : now;
  const end = Math.min(endRaw.getTime(), window.to.getTime());
  if (!(end > start)) return 0;
  return round2((end - start) / 3_600_000);
}

export function totalHours(
  spans: AttendanceSpan[],
  window: { from: Date; to: Date },
  now: Date = new Date(),
): number {
  return round2(spans.reduce((sum, s) => sum + spanHours(s, window, now), 0));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
