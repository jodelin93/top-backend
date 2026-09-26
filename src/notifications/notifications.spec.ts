import * as net from 'net';
import { DataSource, EntityManager } from 'typeorm';
import type { DeliveredEvent } from '../events/event-types';
import type { EventHandler } from '../platform/outbox/event-handler.registry';
import { EventHandlerRegistry } from '../platform/outbox/event-handler.registry';
import { SettingsService } from '../settings/settings.service';
import { EmailChannel } from './email/email-channel';
import {
  buildMessage,
  encodeHeader,
  SmtpEmailChannel,
  smtpConfigFromEnv,
} from './email/smtp-email.channel';
import {
  emailFor,
  inQuietHours,
  minutesInZone,
  wantsEmail,
  DEFAULT_PREFERENCES,
} from './notification-rules';
import { NotificationsService } from './notifications.service';
import { NotificationGeneratorsService } from './notification-generators.service';

const TENANT = '11111111-1111-4111-8111-111111111111';

interface StoredNotification {
  id: string;
  tenantId: string;
  type: string;
  title: string;
  body: string | null;
  dedupeKey: string | null;
  occurrences: number;
  readAt: Date | null;
}

/** notifications table with its partial unique index (tenantId, dedupeKey) WHERE unread */
function fakeNotificationsDb() {
  const rows: StoredNotification[] = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO notifications')) {
      const [tenantId, , , type, , title, body, , , dedupeKey] = params as (
        string | null
      )[];
      const open = dedupeKey
        ? rows.find(
            (r) =>
              r.tenantId === tenantId && r.dedupeKey === dedupeKey && !r.readAt,
          )
        : undefined;
      if (open) {
        open.occurrences += 1;
        open.title = String(title);
        open.body = body;
        return Promise.resolve([{ id: open.id, created: false }]);
      }
      const row = {
        id: `n${rows.length + 1}`,
        tenantId: String(tenantId),
        type: String(type),
        title: String(title),
        body,
        dedupeKey,
        occurrences: 1,
        readAt: null,
      };
      rows.push(row);
      return Promise.resolve([{ id: row.id, created: true }]);
    }
    if (sql.includes('UPDATE notifications SET "readAt" = now()')) {
      const [tenantId, key] = params as string[];
      rows
        .filter((r) => r.tenantId === tenantId && r.dedupeKey === key)
        .forEach((r) => (r.readAt ??= new Date()));
      return Promise.resolve([[], 0]);
    }
    if (sql.includes('SELECT name FROM tenants')) {
      return Promise.resolve([{ name: 'Corner Shop' }]);
    }
    return Promise.resolve([]);
  });
  const dataSource = { query, manager: { query } } as unknown as DataSource;
  return { rows, dataSource, query };
}

const emailChannel = (enabled = true) => {
  const send = jest.fn(() => Promise.resolve());
  return { channel: { enabled, send } as EmailChannel, send };
};

describe('notification rules', () => {
  const at = (iso: string) => new Date(iso);

  it('quiet hours, including ones that wrap midnight', () => {
    const night = {
      quietHoursStart: '22:00',
      quietHoursEnd: '07:00',
      timezone: 'UTC',
    };
    expect(inQuietHours(night, at('2026-01-01T23:30:00Z'))).toBe(true);
    expect(inQuietHours(night, at('2026-01-01T06:59:00Z'))).toBe(true);
    expect(inQuietHours(night, at('2026-01-01T07:00:00Z'))).toBe(false);
    expect(inQuietHours(night, at('2026-01-01T12:00:00Z'))).toBe(false);
    const lunch = {
      ...night,
      quietHoursStart: '12:00',
      quietHoursEnd: '13:00',
    };
    expect(inQuietHours(lunch, at('2026-01-01T12:30:00Z'))).toBe(true);
    expect(
      inQuietHours(
        { ...night, quietHoursEnd: null },
        at('2026-01-01T23:30:00Z'),
      ),
    ).toBe(false);
  });

  it('evaluates quiet hours in the user time zone', () => {
    // 03:00 UTC is 22:00 the day before in New York (winter)
    expect(minutesInZone(at('2026-01-02T03:00:00Z'), 'America/New_York')).toBe(
      22 * 60,
    );
    expect(minutesInZone(at('2026-01-02T03:00:00Z'), 'Not/AZone')).toBe(3 * 60);
  });

  it('e-mail only when opted in, type not muted and outside quiet hours', () => {
    const now = at('2026-01-01T12:00:00Z');
    const prefs = { ...DEFAULT_PREFERENCES, email: true };
    expect(wantsEmail(prefs, 'stock.low', now)).toBe(true);
    expect(wantsEmail({ ...prefs, email: false }, 'stock.low', now)).toBe(
      false,
    );
    expect(
      wantsEmail({ ...prefs, mutedTypes: ['stock.low'] }, 'stock.low', now),
    ).toBe(false);
    expect(
      wantsEmail(
        {
          ...prefs,
          quietHoursStart: '11:00',
          quietHoursEnd: '13:00',
          timezone: 'UTC',
        },
        'stock.low',
        now,
      ),
    ).toBe(false);
  });

  it('e-mails carry the title only, never the body', () => {
    const mail = emailFor(
      { title: '2 card payments unresolved', severity: 'critical' },
      'Corner Shop',
      'https://pos.example.com/',
    );
    expect(mail.subject).toBe(
      '[Action needed] Corner Shop: 2 card payments unresolved',
    );
    expect(mail.text).toContain(
      'https://pos.example.com/account/notifications',
    );
    expect(mail.text).not.toMatch(/card number|customer/i);
  });
});

describe('NotificationsService.notify (de-duplication)', () => {
  it('bumps the open notification with the same key instead of adding one', async () => {
    const db = fakeNotificationsDb();
    const { channel } = emailChannel(false);
    const service = new NotificationsService(db.dataSource, channel);
    const input = {
      tenantId: TENANT,
      type: 'approval.expense' as const,
      title: '1 expense(s) waiting for approval',
      dedupeKey: 'approval.expense',
    };

    const first = await service.notify(input);
    const second = await service.notify({
      ...input,
      title: '2 expense(s) waiting for approval',
    });

    expect(first).toEqual({ id: 'n1', created: true });
    expect(second).toEqual({ id: 'n1', created: false });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({
      occurrences: 2,
      title: '2 expense(s) waiting for approval',
    });
  });

  it('opens a new notification once the previous one was resolved', async () => {
    const db = fakeNotificationsDb();
    const service = new NotificationsService(
      db.dataSource,
      emailChannel(false).channel,
    );
    const input = {
      tenantId: TENANT,
      type: 'stock.low' as const,
      title: 'Low stock',
      dedupeKey: 'stock.low:loc-1',
    };
    await service.notify(input);
    await service.resolve(TENANT, 'stock.low:loc-1');
    const again = await service.notify(input);
    expect(again.created).toBe(true);
    expect(db.rows).toHaveLength(2);
  });

  it('addresses the type permission by default and stores it with the caller transaction', async () => {
    const db = fakeNotificationsDb();
    const service = new NotificationsService(
      db.dataSource,
      emailChannel(false).channel,
    );
    const managerQuery = jest.fn(() =>
      Promise.resolve([{ id: 'm1', created: true }]),
    );
    await service.notify(
      { tenantId: TENANT, type: 'shift.variance', title: 'Variance' },
      { query: managerQuery } as unknown as EntityManager,
    );
    const [, params] = managerQuery.mock.calls[0] as unknown as [
      string,
      unknown[],
    ];
    expect(params[1]).toBeNull(); // recipientUserId
    expect(params[2]).toBe('shifts.manage'); // recipientPermission
    expect(params[4]).toBe('warning'); // severity from the type
    expect(db.query).not.toHaveBeenCalled();
  });

  it('e-mails opted-in recipients once, when the notification is created', async () => {
    const db = fakeNotificationsDb();
    const { channel, send } = emailChannel(true);
    const service = new NotificationsService(db.dataSource, channel);
    jest.spyOn(service, 'emailRecipients').mockResolvedValue([
      {
        userId: 'u1',
        email: 'boss@example.com',
        prefs: { ...DEFAULT_PREFERENCES, email: true },
      },
      {
        userId: 'u2',
        email: 'quiet@example.com',
        prefs: {
          ...DEFAULT_PREFERENCES,
          email: true,
          mutedTypes: ['backup.failed'],
        },
      },
    ]);
    const input = {
      tenantId: TENANT,
      type: 'backup.failed' as const,
      title: 'The database backup failed',
      body: 'pg_dump: connection refused',
      dedupeKey: 'backup.failed',
    };
    await service.notify(input);
    await new Promise((resolve) => setImmediate(resolve));
    await service.notify(input);
    await new Promise((resolve) => setImmediate(resolve));

    expect(send).toHaveBeenCalledTimes(1);
    const [[message]] = send.mock.calls as unknown as [
      [{ to: string; subject: string; text: string }],
    ];
    expect(message.to).toBe('boss@example.com');
    expect(message.subject).toContain('The database backup failed');
    expect(message.text).not.toContain('connection refused');
  });
});

describe('NotificationsService reading (per user, per branch)', () => {
  const reader = {
    id: 'u1',
    tenantId: TENANT,
    permissions: ['inventory.view'],
    branchIds: ['b1'],
  };
  const make = (rows: unknown[] = [{ id: 'n1' }]) => {
    const query = jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('notification_preferences') || sql.includes('COUNT(*)')
          ? [{ total: '0', unread: '0', critical: '0' }]
          : rows,
      ),
    );
    const dataSource = {
      query,
      getRepository: () => ({ findOne: () => Promise.resolve(null) }),
    } as unknown as DataSource;
    return {
      query,
      service: new NotificationsService(
        dataSource,
        emailChannel(false).channel,
      ),
    };
  };

  it('marks a notification read for the reader only, never for the other recipients', async () => {
    const { service, query } = make();
    await expect(service.markRead(reader, 'n1')).resolves.toEqual({
      id: 'n1',
      read: true,
    });
    const [sql, params] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('INSERT INTO notification_reads');
    expect(sql).not.toMatch(/UPDATE notifications/);
    expect(params).toEqual([TENANT, 'u1', ['inventory.view'], ['b1'], 'n1']);
  });

  it('404s a notification the reader cannot see', async () => {
    const { service } = make([]);
    await expect(service.markRead(reader, 'n9')).rejects.toThrow(
      'Notification not found',
    );
  });

  it("limits the list, the count and read-all to the reader's branches", async () => {
    const { service, query } = make();
    await service.list(reader, {});
    await service.unreadCount(reader);
    await service.markAllRead(reader);
    const calls = query.mock.calls as unknown as [string, unknown[]][];
    const scoped = calls.filter(([sql]) =>
      sql.includes('FROM notifications n'),
    );
    expect(scoped.length).toBe(4);
    for (const [sql, params] of scoped) {
      expect(sql).toContain('n."branchId" = ANY($4::uuid[])');
      expect(sql).toContain('notification_reads');
      expect(params[3]).toEqual(['b1']);
    }
    // Every-branch readers: no restriction
    query.mockClear();
    await service.list({ ...reader, branchIds: null }, {});
    expect(
      (query.mock.calls[1] as unknown as [string, unknown[]])[1][3],
    ).toBeNull();
  });
});

describe('NotificationGeneratorsService', () => {
  const setup = (counts: Record<string, number> = {}) => {
    const notifications = {
      notify: jest.fn(() => Promise.resolve({ id: 'n', created: true })),
      resolve: jest.fn(() => Promise.resolve()),
    };
    const handlers = new Map<string, EventHandler<any>>();
    const registry = {
      register: (consumer: string, _types: unknown, handler: EventHandler) =>
        handlers.set(consumer, handler),
    } as unknown as EventHandlerRegistry;
    const query = jest.fn((sql: string): Promise<unknown[]> => {
      if (sql.includes('AS expenses')) {
        return Promise.resolve([
          {
            expenses: String(counts.expenses ?? 0),
            orders: String(counts.orders ?? 0),
            counts: String(counts.counts ?? 0),
          },
        ]);
      }
      if (sql.includes('AS unresolved')) {
        return Promise.resolve([
          {
            unresolved: String(counts.unresolved ?? 0),
            unmatched: String(counts.unmatched ?? 0),
          },
        ]);
      }
      if (sql.includes('FROM devices')) {
        return Promise.resolve([
          {
            id: 'd1',
            name: 'Till 1',
            pendingSales: 3,
            failedSales: 0,
            flagged: true,
          },
          {
            id: 'd2',
            name: 'Till 2',
            pendingSales: 0,
            failedSales: 0,
            flagged: false,
          },
        ]);
      }
      if (sql.includes('FROM stock_levels')) {
        return Promise.resolve([
          {
            variantId: 'v1',
            sku: 'COLA',
            productName: 'Cola',
            locationId: 'loc-1',
            locationName: 'Shop floor',
            available: 1,
            threshold: 5,
          },
        ]);
      }
      if (sql.includes('SELECT "dedupeKey" FROM notifications')) {
        return Promise.resolve([
          { dedupeKey: 'stock.low:loc-1' },
          { dedupeKey: 'stock.low:loc-2' },
        ]);
      }
      return Promise.resolve([]);
    });
    const settings = {
      getSettings: jest.fn(() => Promise.resolve({ lowStockThreshold: 5 })),
    } as unknown as SettingsService;
    const service = new NotificationGeneratorsService(
      { query } as unknown as DataSource,
      notifications as unknown as NotificationsService,
      settings,
      registry,
    );
    service.onModuleInit();
    return { service, notifications, handlers, query };
  };

  it('raises pending approval summaries and clears those back to zero', async () => {
    const { service, notifications } = setup({ expenses: 2, counts: 0 });
    await service.checkPendingApprovals(TENANT);
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'approval.expense',
        title: '2 expense(s) waiting for approval',
        dedupeKey: 'approval.expense',
      }),
    );
    expect(notifications.resolve).toHaveBeenCalledWith(
      TENANT,
      'approval.purchase_order',
    );
    expect(notifications.resolve).toHaveBeenCalledWith(
      TENANT,
      'approval.stock_count',
    );
  });

  it('flags unresolved card payments without amounts or customers', async () => {
    const { service, notifications } = setup({ unresolved: 3 });
    await service.checkUnresolvedPayments(TENANT);
    const [[input]] = notifications.notify.mock.calls as unknown as [
      [{ type: string; title: string; body: string }],
    ];
    expect(input.type).toBe('payment.unresolved');
    expect(input.title).toBe(
      '3 card payment(s) unresolved for more than 15 minutes',
    );
    expect(notifications.resolve).toHaveBeenCalledWith(
      TENANT,
      'payment.settlement_unmatched',
    );
  });

  it('flags devices with unsynced sales, one notification per device', async () => {
    const { service, notifications } = setup();
    await service.checkUnsyncedDevices(TENANT);
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'device.unsynced',
        dedupeKey: 'device.unsynced:d1',
        entityId: 'd1',
      }),
    );
    expect(notifications.resolve).toHaveBeenCalledWith(
      TENANT,
      'device.unsynced:d2',
    );
  });

  it('low stock: one notification per location, cleared when restocked', async () => {
    const { service, notifications } = setup();
    const items = await service.checkLowStock(TENANT);
    expect(items).toHaveLength(1);
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'stock.low',
        title: '1 item(s) low on stock at Shop floor',
        dedupeKey: 'stock.low:loc-1',
        // Only members whose branches work from the location see it
        locationId: 'loc-1',
      }),
    );
    expect(notifications.resolve).toHaveBeenCalledWith(
      TENANT,
      'stock.low:loc-2',
    );
    expect(notifications.resolve).not.toHaveBeenCalledWith(
      TENANT,
      'stock.low:loc-1',
    );
  });

  it('shift.closed over tolerance → variance notification in the consumer transaction', async () => {
    const { handlers, notifications } = setup();
    const handler = handlers.get('notifications.shift-variance')!;
    const manager = {
      query: jest.fn(() => Promise.resolve([{ branchId: 'b1' }])),
    } as unknown as EntityManager;
    const event = (overTolerance: boolean) =>
      ({
        id: 'e1',
        tenantId: TENANT,
        eventType: 'shift.closed',
        payload: {
          shiftId: 's1',
          shiftNumber: 'SH-7',
          registerId: 'r1',
          expected: 100,
          counted: 80,
          variance: -20,
          tolerance: 5,
          overTolerance,
          forceClosed: false,
          closedById: 'u1',
        },
      }) as unknown as DeliveredEvent<'shift.closed'>;

    await handler(event(false), manager);
    expect(notifications.notify).not.toHaveBeenCalled();

    await handler(event(true), manager);
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'shift.variance',
        dedupeKey: 'shift.variance:s1',
        title: 'Shift SH-7 closed with a cash variance over tolerance',
        // Only the register's branch sees it
        branchId: 'b1',
      }),
      manager,
    );
  });

  it('a failing check does not stop the others', async () => {
    const { service, query } = setup();
    query.mockImplementationOnce(() => Promise.reject(new Error('db down')));
    jest
      .spyOn(
        (service as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation();
    const result = await service.runChecks(TENANT);
    expect(result.failed).toEqual(['approvals']);
  });
});

describe('SMTP e-mail channel', () => {
  it('is disabled without SMTP_HOST', () => {
    expect(smtpConfigFromEnv({})).toBeNull();
    expect(
      smtpConfigFromEnv({ SMTP_HOST: 'mail.example.com', SMTP_SECURE: 'true' }),
    ).toMatchObject({
      port: 465,
      secure: true,
      from: 'no-reply@mail.example.com',
    });
  });

  it('builds a safe message (no header injection, encoded subject)', () => {
    expect(encodeHeader('Stock bas: café')).toMatch(/^=\?UTF-8\?B\?/);
    const raw = buildMessage('pos@example.com', {
      to: 'a@example.com\r\nBcc: evil@example.com',
      subject: 'Hi\r\nBcc: x@example.com',
      text: 'Line 1\nLine 2',
    });
    expect(raw).not.toMatch(/\r\nBcc:/);
    expect(raw).toContain('Content-Transfer-Encoding: base64');
  });

  it('talks SMTP to a server (EHLO, AUTH PLAIN, MAIL, RCPT, DATA)', async () => {
    const received: string[] = [];
    let data = '';
    const server = net.createServer((socket) => {
      let inData = false;
      let buffer = '';
      socket.write('220 test ESMTP\r\n');
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        if (inData) {
          if (buffer.includes('\r\n.\r\n')) {
            data = buffer;
            buffer = '';
            inData = false;
            socket.write('250 queued\r\n');
          }
          return;
        }
        let index: number;
        while ((index = buffer.indexOf('\r\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          received.push(line);
          if (line.startsWith('EHLO')) {
            socket.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n');
          } else if (line.startsWith('AUTH PLAIN')) {
            socket.write('235 ok\r\n');
          } else if (line.startsWith('MAIL') || line.startsWith('RCPT')) {
            socket.write('250 ok\r\n');
          } else if (line === 'DATA') {
            inData = true;
            socket.write('354 go\r\n');
          } else if (line === 'QUIT') {
            socket.end('221 bye\r\n');
          }
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as net.AddressInfo;
    try {
      const channel = new SmtpEmailChannel({
        host: '127.0.0.1',
        port,
        secure: false,
        user: 'pos',
        password: 'secret',
        from: 'pos@example.com',
        requireTls: false,
        timeoutMs: 5000,
      });
      await channel.send({
        to: 'boss@example.com',
        subject: 'Low stock',
        text: '.hidden line',
      });
    } finally {
      server.close();
    }
    expect(received[0]).toMatch(/^EHLO /);
    expect(received).toContain(
      `AUTH PLAIN ${Buffer.from('\0pos\0secret').toString('base64')}`,
    );
    expect(received).toContain('MAIL FROM:<pos@example.com>');
    expect(received).toContain('RCPT TO:<boss@example.com>');
    expect(data).toContain('Subject: Low stock');
    expect(data.endsWith('\r\n.\r\n')).toBe(true);
  });

  it('refuses to send in clear text when TLS is required', async () => {
    const server = net.createServer((socket) => {
      socket.write('220 test\r\n');
      socket.on('data', () => socket.write('250 test\r\n'));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as net.AddressInfo;
    try {
      const channel = new SmtpEmailChannel({
        host: '127.0.0.1',
        port,
        secure: false,
        from: 'pos@example.com',
        requireTls: true,
        timeoutMs: 5000,
      });
      await expect(
        channel.send({ to: 'a@example.com', subject: 's', text: 't' }),
      ).rejects.toThrow(/TLS/);
    } finally {
      server.close();
    }
  });
});
