import type { Permission } from '../auth/permissions';
import type { NotificationSeverity } from '../database/entities/notification.entity';

/**
 * Notification types (spec §15): who receives them by default and how serious
 * they are. Titles are written without customer or payment details, because
 * they are also used as e-mail subjects.
 */
export const NOTIFICATION_TYPES = {
  'stock.low': {
    label: 'Low stock',
    severity: 'warning',
    permission: 'inventory.view',
  },
  'approval.expense': {
    label: 'Expenses waiting for approval',
    severity: 'info',
    permission: 'expenses.approve',
  },
  'approval.purchase_order': {
    label: 'Purchase orders waiting for approval',
    severity: 'info',
    permission: 'purchasing.approve',
  },
  'approval.stock_count': {
    label: 'Stock counts waiting for approval',
    severity: 'info',
    permission: 'inventory.count.approve',
  },
  'shift.variance': {
    label: 'Cash variance over tolerance',
    severity: 'warning',
    permission: 'shifts.manage',
  },
  'payment.unresolved': {
    label: 'Card payments needing review',
    severity: 'critical',
    permission: 'payments.reconcile',
  },
  'payment.settlement_unmatched': {
    label: 'Unmatched card settlement lines',
    severity: 'warning',
    permission: 'payments.reconcile',
  },
  'device.unsynced': {
    label: 'Devices with unsynced sales',
    severity: 'warning',
    permission: 'devices.manage',
  },
  'backup.failed': {
    label: 'Backup failed',
    severity: 'critical',
    permission: 'platform.operate',
  },
  'reconciliation.issues': {
    label: 'Reconciliation found issues',
    severity: 'warning',
    permission: 'platform.operate',
  },
  'outbox.stalled': {
    label: 'Background events are stuck',
    severity: 'critical',
    permission: 'platform.operate',
  },
} as const satisfies Record<
  string,
  { label: string; severity: NotificationSeverity; permission: Permission }
>;

export type NotificationType = keyof typeof NOTIFICATION_TYPES;

export const isNotificationType = (value: string): value is NotificationType =>
  Object.prototype.hasOwnProperty.call(NOTIFICATION_TYPES, value);

export interface NotificationPreferences {
  inApp: boolean;
  email: boolean;
  mutedTypes: string[];
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string | null;
}

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  inApp: true,
  email: false,
  mutedTypes: [],
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: null,
};

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isTimeOfDay = (value: string) => HHMM.test(value);

const minutesOf = (value: string) => {
  const match = HHMM.exec(value);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

/** Minutes since midnight of `now` in `timeZone` (UTC when unknown/invalid) */
export function minutesInZone(now: Date, timeZone: string | null): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timeZone || 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    return hour * 60 + minute;
  } catch {
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}

/** Inside the quiet hours (which may wrap midnight, e.g. 22:00–07:00)? */
export function inQuietHours(
  prefs: Pick<
    NotificationPreferences,
    'quietHoursStart' | 'quietHoursEnd' | 'timezone'
  >,
  now: Date,
): boolean {
  if (!prefs.quietHoursStart || !prefs.quietHoursEnd) return false;
  const start = minutesOf(prefs.quietHoursStart);
  const end = minutesOf(prefs.quietHoursEnd);
  if (start === null || end === null || start === end) return false;
  const current = minutesInZone(now, prefs.timezone);
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

/** Should this user get an e-mail for a new notification of `type`? */
export function wantsEmail(
  prefs: NotificationPreferences,
  type: string,
  now: Date,
): boolean {
  return (
    prefs.email && !prefs.mutedTypes.includes(type) && !inQuietHours(prefs, now)
  );
}

/**
 * E-mail text for a notification: its title and a pointer to the app. The
 * body is never included, so no customer or payment details leave the app.
 */
export function emailFor(
  notification: { title: string; severity: string },
  storeName: string,
  appUrl: string | undefined,
): { subject: string; text: string } {
  const prefix = notification.severity === 'critical' ? '[Action needed] ' : '';
  const link = appUrl
    ? `${appUrl.replace(/\/$/, '')}/account/notifications`
    : 'the notifications page of the app';
  return {
    subject: `${prefix}${storeName}: ${notification.title}`.slice(0, 200),
    text: [
      notification.title,
      '',
      `Open ${link} to see the details.`,
      '',
      'You receive this e-mail because e-mail notifications are on in your preferences.',
    ].join('\n'),
  };
}
