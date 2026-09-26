import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { OutboxEvent } from '../../database/entities/outbox-event.entity';
import { requestContext } from '../../common/context/request-context';
import {
  DeliveredEvent,
  DomainEventInput,
  DomainEventType,
  EVENT_AGGREGATES,
  isDomainEventType,
  schemaVersionOf,
} from '../../events/event-types';
import { returnedRows } from './event-handler.registry';

export type OutboxStatusFilter =
  'pending' | 'failed' | 'dead' | 'published' | 'all';

export interface OutboxListQuery {
  status?: OutboxStatusFilter;
  eventType?: string;
  page?: number;
  limit?: number;
}

// Pending events older than this count as stalled (System events page, reconciliation)
export const OUTBOX_STALLED_AFTER_MS = 5 * 60_000;

const STATUS_WHERE: Record<OutboxStatusFilter, string> = {
  pending: `"publishedAt" IS NULL AND "deadLetteredAt" IS NULL AND "lastError" IS NULL`,
  failed: `"publishedAt" IS NULL AND "deadLetteredAt" IS NULL AND "lastError" IS NOT NULL`,
  dead: `"deadLetteredAt" IS NOT NULL`,
  published: `"publishedAt" IS NOT NULL`,
  all: 'TRUE',
};

/** Row of outbox_events as read with raw SQL */
export type OutboxRow = OutboxEvent;

export function toDeliveredEvent(row: OutboxRow): DeliveredEvent {
  return {
    id: row.id,
    tenantId: row.tenantId,
    eventType: row.eventType as DomainEventType,
    aggregateType: row.aggregateType,
    aggregateId: row.aggregateId,
    aggregateVersion: row.aggregateVersion ?? null,
    schemaVersion: row.schemaVersion ?? 1,
    payload: row.payload as DeliveredEvent['payload'],
    correlationId: row.correlationId ?? null,
    actorId: row.actorId ?? null,
    occurredAt: new Date(row.occurredAt),
    attempts: row.attempts ?? 0,
  };
}

/**
 * Transactional outbox (spec §17).
 *
 * record() MUST be called with the EntityManager of the business transaction,
 * so the event is stored if and only if the change commits. Delivery happens
 * later, in the background (OutboxPublisherService).
 */
@Injectable()
export class OutboxService {
  constructor(private dataSource: DataSource) {}

  async record<K extends DomainEventType>(
    manager: EntityManager,
    event: DomainEventInput<K>,
  ): Promise<string> {
    if (!manager?.queryRunner?.isTransactionActive) {
      throw new Error(
        `Outbox event ${event.type} must be recorded inside the business transaction`,
      );
    }
    if (!isDomainEventType(event.type)) {
      throw new Error(`Unknown domain event type: ${String(event.type)}`);
    }
    const context = requestContext.get();
    const id = randomUUID();
    await manager.getRepository(OutboxEvent).insert({
      id,
      tenantId: event.tenantId,
      eventType: event.type,
      aggregateType: event.aggregateType ?? EVENT_AGGREGATES[event.type],
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion ?? null,
      schemaVersion: schemaVersionOf(event.type),
      payload: JSON.parse(JSON.stringify(event.payload)) as Record<string, any>,
      correlationId:
        event.correlationId !== undefined
          ? event.correlationId
          : (context?.requestId ?? null),
      actorId: context?.userId ?? null,
      occurredAt: event.occurredAt ?? new Date(),
    });
    return id;
  }

  // ---------------------------------------------------------------------------
  // Operations (System events page)
  // ---------------------------------------------------------------------------

  /** Backlog and failures of one store's events */
  async stats(tenantId: string) {
    const [row] = await this.dataSource.query<
      {
        pending: string;
        failed: string;
        dead: string;
        publishedLastDay: string;
        oldestPendingAt: Date | null;
        lastPublishedAt: Date | null;
      }[]
    >(
      `SELECT
         COUNT(*) FILTER (WHERE ${STATUS_WHERE.pending}) AS pending,
         COUNT(*) FILTER (WHERE ${STATUS_WHERE.failed}) AS failed,
         COUNT(*) FILTER (WHERE ${STATUS_WHERE.dead}) AS dead,
         COUNT(*) FILTER (WHERE "publishedAt" >= now() - interval '1 day') AS "publishedLastDay",
         MIN("occurredAt") FILTER (WHERE "publishedAt" IS NULL AND "deadLetteredAt" IS NULL) AS "oldestPendingAt",
         MAX("publishedAt") AS "lastPublishedAt"
       FROM outbox_events WHERE "tenantId" = $1`,
      [tenantId],
    );
    const oldest = row?.oldestPendingAt ? new Date(row.oldestPendingAt) : null;
    const lagMs = oldest ? Math.max(0, Date.now() - oldest.getTime()) : 0;
    return {
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0),
      deadLettered: Number(row?.dead ?? 0),
      publishedLastDay: Number(row?.publishedLastDay ?? 0),
      oldestPendingAt: oldest,
      lastPublishedAt: row?.lastPublishedAt ?? null,
      lagMs,
      stalled: lagMs > OUTBOX_STALLED_AFTER_MS,
    };
  }

  async list(tenantId: string, query: OutboxListQuery) {
    const status = query.status ?? 'all';
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const qb = this.dataSource
      .getRepository(OutboxEvent)
      .createQueryBuilder('e')
      .where('e.tenantId = :tenantId', { tenantId })
      .andWhere(STATUS_WHERE[status].replace(/"(\w+)"/g, 'e."$1"'))
      .orderBy('e.occurredAt', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    if (query.eventType) {
      qb.andWhere('e.eventType = :eventType', { eventType: query.eventType });
    }
    const [rows, total] = await qb.getManyAndCount();
    return {
      data: rows.map((row) => ({ ...row, status: statusOf(row) })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async get(tenantId: string, id: string) {
    const row = await this.dataSource
      .getRepository(OutboxEvent)
      .findOne({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('Event not found');
    const consumers = await this.dataSource.query<
      { consumer: string; processedAt: Date }[]
    >(
      `SELECT consumer, "processedAt" FROM inbox_events WHERE "eventId" = $1 ORDER BY "processedAt"`,
      [id],
    );
    return { ...row, status: statusOf(row), consumers };
  }

  /**
   * Deliver a failed or dead-lettered event again (consumers that already
   * handled it are still skipped). Resets the attempt count.
   */
  async retry(tenantId: string, id: string) {
    const rows = returnedRows<{ id: string }>(
      await this.dataSource.query(
        `UPDATE outbox_events
            SET "deadLetteredAt" = NULL, "nextAttemptAt" = now(), attempts = 0, "lockedUntil" = NULL
          WHERE id = $1 AND "tenantId" = $2 AND "publishedAt" IS NULL
          RETURNING id`,
        [id, tenantId],
      ),
    );
    if (!rows.length) {
      await this.get(tenantId, id);
      throw new BadRequestException(
        'This event was already delivered; replay it instead',
      );
    }
    return this.get(tenantId, id);
  }

  /**
   * Deliver an event again to its consumers (all, or one), even those that
   * already handled it: their inbox rows are removed first. Consumers must
   * tolerate this (they are written to be idempotent on their own data).
   */
  async replay(tenantId: string, id: string, consumer?: string) {
    await this.dataSource.transaction(async (manager) => {
      const rows = returnedRows<{ id: string }>(
        await manager.query(
          `UPDATE outbox_events
              SET "publishedAt" = NULL, "deadLetteredAt" = NULL, "nextAttemptAt" = now(),
                  attempts = 0, "lockedUntil" = NULL
            WHERE id = $1 AND "tenantId" = $2
            RETURNING id`,
          [id, tenantId],
        ),
      );
      if (!rows.length) throw new NotFoundException('Event not found');
      await manager.query(
        consumer
          ? `DELETE FROM inbox_events WHERE "eventId" = $1 AND consumer = $2`
          : `DELETE FROM inbox_events WHERE "eventId" = $1`,
        consumer ? [id, consumer] : [id],
      );
    });
    return this.get(tenantId, id);
  }
}

export function statusOf(
  row: Pick<OutboxRow, 'publishedAt' | 'deadLetteredAt' | 'lastError'>,
): 'published' | 'dead' | 'failed' | 'pending' {
  if (row.publishedAt) return 'published';
  if (row.deadLetteredAt) return 'dead';
  return row.lastError ? 'failed' : 'pending';
}
