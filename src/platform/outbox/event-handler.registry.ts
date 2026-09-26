import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type { DeliveredEvent, DomainEventType } from '../../events/event-types';

/**
 * A consumer's reaction to an event. It runs in its own transaction together
 * with the consumer's inbox row: use `manager` for database effects so they
 * happen exactly once. Side effects outside the database (e-mail) are
 * at-least-once.
 */
export type EventHandler<K extends DomainEventType = DomainEventType> = (
  event: DeliveredEvent<K>,
  manager: EntityManager,
) => Promise<void>;

interface Registration {
  consumer: string;
  types: ReadonlySet<string> | '*';
  handler: EventHandler<any>;
}

export interface DispatchFailure {
  consumer: string;
  error: string;
}

export interface DispatchResult {
  handled: string[];
  // Consumers that had already processed the event (inbox row present)
  skipped: string[];
  failures: DispatchFailure[];
}

const CONSUMER_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/**
 * In-process consumers of outbox events, registered by event type
 * (usually from a module's onModuleInit). Each consumer name must be stable:
 * it keys the inbox rows that de-duplicate deliveries.
 */
@Injectable()
export class EventHandlerRegistry {
  private readonly logger = new Logger(EventHandlerRegistry.name);
  private readonly registrations: Registration[] = [];

  constructor(private dataSource: DataSource) {}

  register<K extends DomainEventType>(
    consumer: string,
    types: K | K[] | '*',
    handler: EventHandler<K>,
  ): void {
    if (!CONSUMER_NAME.test(consumer)) {
      throw new Error(`Invalid event consumer name: ${consumer}`);
    }
    if (this.registrations.some((r) => r.consumer === consumer)) {
      throw new Error(`Event consumer already registered: ${consumer}`);
    }
    this.registrations.push({
      consumer,
      types:
        types === '*' ? '*' : new Set(Array.isArray(types) ? types : [types]),
      handler,
    });
  }

  consumersOf(eventType: string): string[] {
    return this.matching(eventType).map((r) => r.consumer);
  }

  /**
   * Deliver one event to every consumer interested in it. A consumer that
   * already handled it (inbox row) is skipped; a failing consumer does not stop
   * the others, and its transaction (inbox row included) is rolled back so the
   * next delivery retries it.
   */
  async dispatch(
    event: DeliveredEvent,
    onlyConsumer?: string,
  ): Promise<DispatchResult> {
    const result: DispatchResult = { handled: [], skipped: [], failures: [] };
    for (const registration of this.matching(event.eventType)) {
      if (onlyConsumer && registration.consumer !== onlyConsumer) continue;
      try {
        const ran = await this.dataSource.transaction(async (manager) => {
          const claimed = await manager.query<unknown>(
            `INSERT INTO inbox_events (consumer, "eventId", "tenantId", "eventType")
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (consumer, "eventId") DO NOTHING
             RETURNING consumer`,
            [registration.consumer, event.id, event.tenantId, event.eventType],
          );
          if (!returnedRows(claimed).length) return false;
          await registration.handler(event, manager);
          return true;
        });
        (ran ? result.handled : result.skipped).push(registration.consumer);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Consumer ${registration.consumer} failed on ${event.eventType} ${event.id}: ${message}`,
        );
        result.failures.push({
          consumer: registration.consumer,
          error: message,
        });
      }
    }
    return result;
  }

  private matching(eventType: string) {
    return this.registrations.filter(
      (r) => r.types === '*' || r.types.has(eventType),
    );
  }
}

/** Rows of an INSERT/UPDATE ... RETURNING (node-postgres may return [rows, count]) */
export function returnedRows<T = Record<string, unknown>>(
  result: unknown,
): T[] {
  if (!Array.isArray(result)) return [];
  if (result.length === 2 && Array.isArray(result[0])) {
    return result[0] as T[];
  }
  return result as T[];
}
