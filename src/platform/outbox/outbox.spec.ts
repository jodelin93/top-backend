import { Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { OutboxEvent } from '../../database/entities/outbox-event.entity';
import { requestContext } from '../../common/context/request-context';
import { EventHandlerRegistry, returnedRows } from './event-handler.registry';
import { OutboxService, statusOf } from './outbox.service';
import { OutboxPublisherService } from './outbox-publisher.service';
import { afterFailure, retryDelayMs } from './outbox-backoff';

const TENANT = '11111111-1111-4111-8111-111111111111';

// Failed deliveries are logged; keep the test output clean
beforeAll(() => {
  jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  jest.spyOn(Logger.prototype, 'error').mockImplementation();
});
afterAll(() => jest.restoreAllMocks());

type Row = OutboxEvent;

/** In-memory outbox_events + inbox_events speaking the SQL the services send */
function fakeDb(initial: Partial<Row>[] = []) {
  const outbox: Row[] = initial.map((r, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    tenantId: TENANT,
    eventType: 'shift.closed',
    aggregateType: 'shift',
    aggregateId: 'shift-1',
    aggregateVersion: 2,
    schemaVersion: 1,
    payload: { overTolerance: true },
    correlationId: 'req-1',
    actorId: null,
    occurredAt: new Date(Date.now() - 1000 * (10 - i)),
    publishedAt: null,
    attempts: 0,
    lastError: null,
    nextAttemptAt: new Date(Date.now() - 1),
    lockedUntil: null,
    deadLetteredAt: null,
    ...r,
  }));
  const inbox = new Set<string>();

  const query = jest.fn((sql: string, params: unknown[] = []) => {
    const now = Date.now();
    if (sql.includes('RETURNING o.*')) {
      const [limit, claimMs] = params as [number, number];
      const due = outbox
        .filter(
          (r) =>
            !r.publishedAt &&
            !r.deadLetteredAt &&
            r.nextAttemptAt.getTime() <= now &&
            (!r.lockedUntil || r.lockedUntil.getTime() < now),
        )
        .slice(0, limit);
      for (const r of due) {
        r.attempts += 1;
        r.lockedUntil = new Date(now + claimMs);
      }
      return Promise.resolve([due.map((r) => ({ ...r })), due.length]);
    }
    if (sql.includes('SET "publishedAt" = now()')) {
      const row = outbox.find((r) => r.id === params[0])!;
      row.publishedAt = new Date();
      row.lockedUntil = null;
      row.lastError = null;
      return Promise.resolve([[], 1]);
    }
    if (sql.includes('SET "lastError" = $2')) {
      const [id, error, next, dead] = params as [string, string, Date, boolean];
      const row = outbox.find((r) => r.id === id)!;
      row.lastError = error;
      row.lockedUntil = null;
      row.nextAttemptAt = next;
      row.deadLetteredAt = dead ? new Date() : null;
      return Promise.resolve([[], 1]);
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });

  // Each consumer runs in a "transaction": its inbox row only sticks if it succeeds
  const transaction = jest.fn(
    async (fn: (manager: EntityManager) => Promise<unknown>) => {
      const staged: string[] = [];
      const manager = {
        query: (sql: string, params: unknown[]) => {
          if (sql.includes('INSERT INTO inbox_events')) {
            const key = `${String(params[0])}|${String(params[1])}`;
            if (inbox.has(key) || staged.includes(key)) {
              return Promise.resolve([]);
            }
            staged.push(key);
            return Promise.resolve([{ consumer: params[0] }]);
          }
          return Promise.resolve([]);
        },
      } as unknown as EntityManager;
      const result = await fn(manager);
      staged.forEach((key) => inbox.add(key));
      return result;
    },
  );

  const dataSource = { query, transaction } as unknown as DataSource;
  return { outbox, inbox, dataSource, query };
}

describe('OutboxService.record', () => {
  const insert = jest.fn(() => Promise.resolve());
  const manager = (active: boolean) =>
    ({
      queryRunner: { isTransactionActive: active },
      getRepository: () => ({ insert }),
    }) as unknown as EntityManager;

  beforeEach(() => insert.mockClear());

  it('stores the event with its aggregate, schema version and request id', async () => {
    const service = new OutboxService({} as DataSource);
    const id = await requestContext.run(
      { requestId: 'req-42', userId: 'user-1' },
      () =>
        service.record(manager(true), {
          tenantId: TENANT,
          type: 'expense.paid',
          aggregateId: 'exp-1',
          aggregateVersion: 3,
          payload: {
            expenseId: 'exp-1',
            expenseNumber: 'EXP-1',
            amount: 12.5,
            currencyCode: 'USD',
            paymentMethod: 'cash',
            registerId: null,
            shiftId: null,
          },
        }),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        tenantId: TENANT,
        eventType: 'expense.paid',
        aggregateType: 'expense',
        aggregateId: 'exp-1',
        aggregateVersion: 3,
        schemaVersion: 1,
        correlationId: 'req-42',
        actorId: 'user-1',
      }),
    );
  });

  it('refuses to record outside a transaction', async () => {
    const service = new OutboxService({} as DataSource);
    await expect(
      service.record(manager(false), {
        tenantId: TENANT,
        type: 'shift.opened',
        aggregateId: 's',
        payload: {
          shiftId: 's',
          shiftNumber: 'SH-1',
          registerId: 'r',
          openingFloat: 0,
          openedById: 'u',
        },
      }),
    ).rejects.toThrow(/inside the business transaction/);
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses unknown event types', async () => {
    const service = new OutboxService({} as DataSource);
    await expect(
      service.record(manager(true), {
        tenantId: TENANT,
        type: 'nope' as never,
        aggregateId: 'x',
        payload: {} as never,
      }),
    ).rejects.toThrow(/Unknown domain event type/);
  });
});

describe('backoff', () => {
  const policy = { baseMs: 1000, maxMs: 10_000, maxAttempts: 4 };

  it('doubles the delay up to the maximum', () => {
    expect([1, 2, 3, 4, 5, 6].map((a) => retryDelayMs(a, policy))).toEqual([
      1000, 2000, 4000, 8000, 10_000, 10_000,
    ]);
  });

  it('dead-letters after the maximum attempts', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(afterFailure(3, now, policy)).toEqual({
      deadLetter: false,
      nextAttemptAt: new Date(now.getTime() + 4000),
    });
    expect(afterFailure(4, now, policy).deadLetter).toBe(true);
  });
});

describe('OutboxPublisherService', () => {
  it('delivers due events to consumers and marks them published', async () => {
    const db = fakeDb([{}, {}]);
    const registry = new EventHandlerRegistry(db.dataSource);
    const seen: string[] = [];
    registry.register('test.consumer', 'shift.closed', (event) => {
      seen.push(event.id);
      return Promise.resolve();
    });
    const publisher = new OutboxPublisherService(db.dataSource, registry);

    const summary = await publisher.publishPending();

    expect(summary).toEqual({
      claimed: 2,
      published: 2,
      failed: 0,
      deadLettered: 0,
    });
    expect(seen).toHaveLength(2);
    expect(db.outbox.every((r) => r.publishedAt && r.attempts === 1)).toBe(
      true,
    );
    expect(db.outbox.map(statusOf)).toEqual(['published', 'published']);
  });

  it('retries a failing consumer with backoff, then dead-letters it', async () => {
    const db = fakeDb([{}]);
    const registry = new EventHandlerRegistry(db.dataSource);
    registry.register('always.fails', 'shift.closed', () =>
      Promise.reject(new Error('boom')),
    );
    const publisher = new OutboxPublisherService(db.dataSource, registry);
    Object.assign(publisher.policy, {
      baseMs: 60_000,
      maxMs: 60_000,
      maxAttempts: 3,
    });
    const row = db.outbox[0];

    let summary = await publisher.publishPending();
    expect(summary.failed).toBe(1);
    expect(row.lastError).toContain('always.fails: boom');
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
    expect(statusOf(row)).toBe('failed');

    // Not due yet: nothing is claimed
    summary = await publisher.publishPending();
    expect(summary.claimed).toBe(0);

    // Due again twice more → dead letter at the 3rd attempt
    row.nextAttemptAt = new Date(Date.now() - 1);
    await publisher.publishPending();
    row.nextAttemptAt = new Date(Date.now() - 1);
    summary = await publisher.publishPending();
    expect(summary.deadLettered).toBe(1);
    expect(row.attempts).toBe(3);
    expect(row.deadLetteredAt).toBeInstanceOf(Date);
    expect(statusOf(row)).toBe('dead');

    // Dead-lettered events are never claimed again
    row.nextAttemptAt = new Date(Date.now() - 1);
    expect((await publisher.publishPending()).claimed).toBe(0);
  });

  it('skips events another instance holds (lease not expired)', async () => {
    const db = fakeDb([{ lockedUntil: new Date(Date.now() + 30_000) }]);
    const publisher = new OutboxPublisherService(
      db.dataSource,
      new EventHandlerRegistry(db.dataSource),
    );
    expect((await publisher.publishPending()).claimed).toBe(0);
  });
});

describe('EventHandlerRegistry (inbox de-duplication)', () => {
  const event = {
    id: '00000000-0000-4000-8000-0000000000aa',
    tenantId: TENANT,
    eventType: 'shift.closed' as const,
    aggregateType: 'shift',
    aggregateId: 's',
    aggregateVersion: null,
    schemaVersion: 1,
    payload: {} as never,
    correlationId: null,
    actorId: null,
    occurredAt: new Date(),
    attempts: 1,
  };

  it('runs each consumer once per event, even when redelivered', async () => {
    const db = fakeDb();
    const registry = new EventHandlerRegistry(db.dataSource);
    const effects: string[] = [];
    registry.register('a', 'shift.closed', () => {
      effects.push('a');
      return Promise.resolve();
    });
    registry.register('b', '*', () => {
      effects.push('b');
      return Promise.resolve();
    });

    const first = await registry.dispatch(event);
    const second = await registry.dispatch(event);

    expect(first).toEqual({ handled: ['a', 'b'], skipped: [], failures: [] });
    expect(second).toEqual({ handled: [], skipped: ['a', 'b'], failures: [] });
    expect(effects).toEqual(['a', 'b']);
  });

  it('retries only the consumer that failed (its inbox row is rolled back)', async () => {
    const db = fakeDb();
    const registry = new EventHandlerRegistry(db.dataSource);
    let failNext = true;
    const effects: string[] = [];
    registry.register('ok', 'shift.closed', () => {
      effects.push('ok');
      return Promise.resolve();
    });
    registry.register('flaky', 'shift.closed', () => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error('temporary'));
      }
      effects.push('flaky');
      return Promise.resolve();
    });

    const first = await registry.dispatch(event);
    expect(first.failures).toEqual([{ consumer: 'flaky', error: 'temporary' }]);
    const second = await registry.dispatch(event);
    expect(second).toEqual({
      handled: ['flaky'],
      skipped: ['ok'],
      failures: [],
    });
    expect(effects).toEqual(['ok', 'flaky']);
  });

  it('rejects duplicate or invalid consumer names', () => {
    const registry = new EventHandlerRegistry({} as DataSource);
    registry.register('one', 'shift.closed', () => Promise.resolve());
    expect(() =>
      registry.register('one', 'shift.opened', () => Promise.resolve()),
    ).toThrow(/already registered/);
    expect(() =>
      registry.register('Bad Name', 'shift.opened', () => Promise.resolve()),
    ).toThrow(/Invalid/);
  });
});

describe('returnedRows', () => {
  it('reads INSERT (rows) and UPDATE ([rows, count]) results', () => {
    expect(returnedRows([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(returnedRows([[{ id: 1 }], 1])).toEqual([{ id: 1 }]);
    expect(returnedRows([[], 0])).toEqual([]);
    expect(returnedRows(undefined)).toEqual([]);
  });
});
