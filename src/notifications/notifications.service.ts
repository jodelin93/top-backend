import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { NotificationSeverity } from '../database/entities/notification.entity';
import { NotificationPreference } from '../database/entities/notification-preference.entity';
import { returnedRows } from '../platform/outbox/event-handler.registry';
import { resolvePermissions } from '../roles/role-permissions';
import { branchLocationIdsSql } from '../auth/branch-scope';
import { maskEmailsIn } from '../documents/print-job-rules';
import type { TenantRole } from '../database/entities/tenant-role.entity';
import { EMAIL_CHANNEL, type EmailChannel } from './email/email-channel';
import {
  DEFAULT_PREFERENCES,
  emailFor,
  isNotificationType,
  isTimeOfDay,
  NOTIFICATION_TYPES,
  NotificationPreferences,
  NotificationType,
  wantsEmail,
} from './notification-rules';

export interface NotifyInput {
  tenantId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  severity?: NotificationSeverity;
  entityType?: string | null;
  entityId?: string | null;
  // One open notification per key: raising it again bumps its occurrences
  dedupeKey?: string | null;
  // One user; otherwise everyone with the type's permission (or `recipientPermission`)
  recipientUserId?: string | null;
  recipientPermission?: string | null;
  // What the alert is about: only members of that branch / working from that
  // location see it. An alert about a record (entityId) with neither is shown
  // only to members of every branch; a store-wide summary (no record) to all.
  branchId?: string | null;
  locationId?: string | null;
}

export interface NotifyResult {
  id: string;
  // false when an open notification with the same dedupeKey was bumped instead
  created: boolean;
}

/** Who is reading: the signed-in user, their effective permissions and branches */
export interface NotificationReader {
  id: string;
  tenantId: string;
  permissions: readonly string[];
  // null: every branch (see auth/branch-scope)
  branchIds: readonly string[] | null;
}

export interface ListNotificationsQuery {
  unreadOnly?: boolean;
  type?: string;
  page?: number;
  limit?: number;
}

/**
 * A notification is shown to its user, or to everyone holding its permission
 * whose branches it concerns ($4: the reader's branch ids, NULL = every branch):
 * its branch, its stock location (one the reader's branches work from), or a
 * store-wide summary. One about a record whose branch is unknown: every-branch
 * members only.
 */
const VISIBLE = `n."tenantId" = $1
  AND (n."recipientUserId" = $2
       OR (n."recipientUserId" IS NULL
           AND (n."recipientPermission" IS NULL OR n."recipientPermission" = ANY($3::text[]))
           AND ($4::uuid[] IS NULL
                OR n."branchId" = ANY($4::uuid[])
                OR (n."branchId" IS NULL AND n."locationId" IN ${branchLocationIdsSql('$4', '$1')})
                OR (n."branchId" IS NULL AND n."locationId" IS NULL AND n."entityId" IS NULL))))`;

// The reader's own read state ($2); `r` must be joined with READ_JOIN
const READ_JOIN = `LEFT JOIN notification_reads r ON r."notificationId" = n.id AND r."userId" = $2`;
// Unread: open, and not read by this user since it last occurred
const UNREAD = `n."readAt" IS NULL AND (r."readAt" IS NULL OR r."readAt" < n."lastOccurredAt")`;

const readerParams = (reader: NotificationReader): unknown[] => [
  reader.tenantId,
  reader.id,
  [...reader.permissions],
  reader.branchIds === null ? null : [...reader.branchIds],
];

/**
 * Notification centre (spec §15): stores notifications with de-duplication,
 * lists them per user, keeps per-user preferences and sends e-mail copies
 * through the configured EmailChannel.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private dataSource: DataSource,
    @Inject(EMAIL_CHANNEL) private email: EmailChannel,
  ) {}

  /**
   * Raise a notification. Pass the transaction's manager to store it with the
   * change that caused it. E-mail copies go out once, when it is created.
   */
  async notify(
    input: NotifyInput,
    manager?: EntityManager,
  ): Promise<NotifyResult> {
    const definition = NOTIFICATION_TYPES[input.type];
    const recipientPermission = input.recipientUserId
      ? null
      : (input.recipientPermission ?? definition.permission);
    const params = [
      input.tenantId,
      input.recipientUserId ?? null,
      recipientPermission,
      input.type,
      input.severity ?? definition.severity,
      input.title.slice(0, 255),
      input.body ?? null,
      input.entityType ?? null,
      input.entityId ?? null,
      input.dedupeKey ? input.dedupeKey.slice(0, 255) : null,
      input.branchId ?? null,
      input.locationId ?? null,
    ];
    const [row] = returnedRows<{ id: string; created: boolean }>(
      await (manager ?? this.dataSource.manager).query(
        `INSERT INTO notifications
           ("tenantId", "recipientUserId", "recipientPermission", type, severity,
            title, body, "entityType", "entityId", "dedupeKey", "branchId", "locationId")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT ("tenantId", "dedupeKey") WHERE "readAt" IS NULL AND "dedupeKey" IS NOT NULL
         DO UPDATE SET occurrences = notifications.occurrences + 1,
                       "lastOccurredAt" = now(),
                       title = EXCLUDED.title,
                       body = EXCLUDED.body,
                       severity = EXCLUDED.severity,
                       "branchId" = EXCLUDED."branchId",
                       "locationId" = EXCLUDED."locationId"
         RETURNING id, (xmax = 0) AS created`,
        params,
      ),
    );
    const result = { id: row.id, created: row.created === true };
    if (result.created && this.email.enabled) {
      // Never blocks nor fails the caller
      void this.sendEmails(input, recipientPermission).catch((error) =>
        this.logger.warn(
          `Notification e-mail failed: ${maskEmailsIn(error instanceof Error ? error.message : String(error))}`,
        ),
      );
    }
    return result;
  }

  /** Close open notifications with this key (the condition cleared): read for everyone */
  async resolve(tenantId: string, dedupeKey: string, manager?: EntityManager) {
    await (manager ?? this.dataSource.manager).query(
      `UPDATE notifications SET "readAt" = now()
        WHERE "tenantId" = $1 AND "dedupeKey" = $2 AND "readAt" IS NULL`,
      [tenantId, dedupeKey],
    );
  }

  // ---------------------------------------------------------------------------
  // Reading (per user)
  // ---------------------------------------------------------------------------

  async list(reader: NotificationReader, query: ListNotificationsQuery) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 25));
    const prefs = await this.getPreferences(reader.tenantId, reader.id);
    const params: unknown[] = [...readerParams(reader), prefs.mutedTypes];
    let where = `${VISIBLE} AND NOT (n.type = ANY($5::text[]))`;
    if (query.unreadOnly) where += ` AND ${UNREAD}`;
    if (query.type) {
      params.push(query.type);
      where += ` AND n.type = $${params.length}`;
    }
    const [{ total }] = await this.dataSource.query<{ total: string }[]>(
      `SELECT COUNT(*) AS total FROM notifications n ${READ_JOIN} WHERE ${where}`,
      params,
    );
    // readAt / readById: this reader's read (or when the alert was closed)
    const rows = await this.dataSource.query<Record<string, unknown>[]>(
      `SELECT n.id, n.type, n.severity, n.title, n.body, n."entityType", n."entityId",
              n.occurrences, n."lastOccurredAt",
              CASE WHEN ${UNREAD} THEN NULL ELSE COALESCE(r."readAt", n."readAt") END AS "readAt",
              CASE WHEN ${UNREAD} THEN NULL
                   WHEN r."readAt" IS NOT NULL THEN r."userId" ELSE n."readById" END AS "readById",
              n."createdAt", n."recipientUserId", n."branchId"
         FROM notifications n ${READ_JOIN}
        WHERE ${where}
        ORDER BY (${UNREAD}) DESC, n."lastOccurredAt" DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
      params,
    );
    return {
      data: rows,
      meta: {
        total: Number(total),
        page,
        limit,
        totalPages: Math.ceil(Number(total) / limit),
      },
    };
  }

  /** Unread count for the bell (0 when in-app notifications are off) */
  async unreadCount(reader: NotificationReader) {
    const prefs = await this.getPreferences(reader.tenantId, reader.id);
    if (!prefs.inApp) return { unread: 0, critical: 0 };
    const [row] = await this.dataSource.query<
      { unread: string; critical: string }[]
    >(
      `SELECT COUNT(*) AS unread, COUNT(*) FILTER (WHERE n.severity = 'critical') AS critical
         FROM notifications n ${READ_JOIN}
        WHERE ${VISIBLE} AND ${UNREAD} AND NOT (n.type = ANY($5::text[]))`,
      [...readerParams(reader), prefs.mutedTypes],
    );
    return {
      unread: Number(row?.unread ?? 0),
      critical: Number(row?.critical ?? 0),
    };
  }

  /** Mark one notification read, for this reader only */
  async markRead(reader: NotificationReader, id: string) {
    const rows = returnedRows<{ id: string }>(
      await this.dataSource.query(
        `INSERT INTO notification_reads ("notificationId", "userId", "tenantId", "readAt")
         SELECT n.id, $2, n."tenantId", now() FROM notifications n
          WHERE ${VISIBLE} AND n.id = $5
         ON CONFLICT ("notificationId", "userId") DO UPDATE SET "readAt" = now()
         RETURNING "notificationId" AS id`,
        [...readerParams(reader), id],
      ),
    );
    if (!rows.length) throw new NotFoundException('Notification not found');
    return { id, read: true };
  }

  /** Mark everything this reader sees read (for them only) */
  async markAllRead(reader: NotificationReader) {
    const rows = returnedRows<{ id: string }>(
      await this.dataSource.query(
        `INSERT INTO notification_reads ("notificationId", "userId", "tenantId", "readAt")
         SELECT n.id, $2, n."tenantId", now() FROM notifications n ${READ_JOIN}
          WHERE ${VISIBLE} AND ${UNREAD}
         ON CONFLICT ("notificationId", "userId") DO UPDATE SET "readAt" = now()
         RETURNING "notificationId" AS id`,
        readerParams(reader),
      ),
    );
    return { updated: rows.length };
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  async getPreferences(
    tenantId: string,
    userId: string,
  ): Promise<NotificationPreferences> {
    const row = await this.dataSource
      .getRepository(NotificationPreference)
      .findOne({ where: { tenantId, userId } });
    if (!row) return { ...DEFAULT_PREFERENCES, mutedTypes: [] };
    return {
      inApp: row.inApp,
      email: row.email,
      mutedTypes: Array.isArray(row.mutedTypes) ? row.mutedTypes : [],
      quietHoursStart: row.quietHoursStart,
      quietHoursEnd: row.quietHoursEnd,
      timezone: row.timezone,
    };
  }

  async updatePreferences(
    tenantId: string,
    userId: string,
    patch: Partial<NotificationPreferences>,
  ) {
    const current = await this.getPreferences(tenantId, userId);
    const next = { ...current, ...patch };
    next.mutedTypes = [...new Set(next.mutedTypes)].filter(isNotificationType);
    for (const value of [next.quietHoursStart, next.quietHoursEnd]) {
      if (value && !isTimeOfDay(value)) {
        throw new BadRequestException('Quiet hours must be HH:MM');
      }
    }
    if (!next.quietHoursStart !== !next.quietHoursEnd) {
      throw new BadRequestException(
        'Quiet hours need both a start and an end time',
      );
    }
    if (next.timezone && !isValidTimeZone(next.timezone)) {
      throw new BadRequestException('Unknown time zone');
    }
    await this.dataSource.getRepository(NotificationPreference).upsert(
      {
        tenantId,
        userId,
        ...next,
        updatedAt: new Date(),
      },
      ['tenantId', 'userId'],
    );
    return {
      ...next,
      emailAvailable: this.email.enabled,
    };
  }

  /** Catalogue of types for the preferences screen */
  types() {
    return Object.entries(NOTIFICATION_TYPES).map(([type, definition]) => ({
      type,
      label: definition.label,
      severity: definition.severity,
      permission: definition.permission,
    }));
  }

  get emailAvailable() {
    return this.email.enabled;
  }

  // ---------------------------------------------------------------------------
  // E-mail
  // ---------------------------------------------------------------------------

  private async sendEmails(input: NotifyInput, permission: string | null) {
    const recipients = await this.emailRecipients(
      input.tenantId,
      input.recipientUserId ?? null,
      permission,
    );
    if (!recipients.length) return;
    const [store] = await this.dataSource.query<{ name: string }[]>(
      `SELECT name FROM tenants WHERE id = $1`,
      [input.tenantId],
    );
    const severity = input.severity ?? NOTIFICATION_TYPES[input.type].severity;
    const message = emailFor(
      { title: input.title, severity },
      store?.name ?? 'POS',
      process.env.APP_URL || process.env.FRONTEND_URL,
    );
    const now = new Date();
    for (const recipient of recipients) {
      if (!wantsEmail(recipient.prefs, input.type, now)) continue;
      try {
        await this.email.send({ to: recipient.email, ...message });
      } catch (error) {
        this.logger.warn(
          `Could not e-mail user ${recipient.userId}: ${maskEmailsIn(error instanceof Error ? error.message : String(error))}`,
        );
      }
    }
  }

  /** Active members who should get the e-mail, with their preferences */
  async emailRecipients(
    tenantId: string,
    userId: string | null,
    permission: string | null,
  ) {
    const members = await this.dataSource.query<
      {
        userId: string;
        email: string;
        role: string;
        permissions: string[] | null;
        inApp: boolean | null;
        emailOn: boolean | null;
        mutedTypes: string[] | null;
        quietHoursStart: string | null;
        quietHoursEnd: string | null;
        timezone: string | null;
      }[]
    >(
      `SELECT m."userId", u.email, m.role, r.permissions,
              p."inApp", p.email AS "emailOn", p."mutedTypes",
              p."quietHoursStart", p."quietHoursEnd", p.timezone
         FROM tenant_memberships m
         JOIN users u ON u.id = m."userId"
         JOIN notification_preferences p ON p."tenantId" = m."tenantId" AND p."userId" = m."userId" AND p.email = true
         LEFT JOIN tenant_roles r ON r."tenantId" = m."tenantId" AND r.key = m.role
        WHERE m."tenantId" = $1 AND m.status = 'active' AND u.email IS NOT NULL
          AND ($2::uuid IS NULL OR m."userId" = $2)`,
      [tenantId, userId],
    );
    return members
      .filter((m) => {
        if (userId) return true;
        if (!permission) return true;
        const role = m.permissions
          ? ({ permissions: m.permissions } as Pick<TenantRole, 'permissions'>)
          : null;
        return (resolvePermissions(m.role, role) as string[]).includes(
          permission,
        );
      })
      .map((m) => ({
        userId: m.userId,
        email: m.email,
        prefs: {
          inApp: m.inApp ?? true,
          email: m.emailOn ?? false,
          mutedTypes: m.mutedTypes ?? [],
          quietHoursStart: m.quietHoursStart,
          quietHoursEnd: m.quietHoursEnd,
          timezone: m.timezone,
        },
      }));
  }
}

function isValidTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
