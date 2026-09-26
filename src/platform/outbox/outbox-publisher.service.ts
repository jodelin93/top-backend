import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  Optional,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { DataSource } from 'typeorm';
import { EventHandlerRegistry, returnedRows } from './event-handler.registry';
import { OutboxRow, toDeliveredEvent } from './outbox.service';
import { afterFailure, BackoffPolicy, backoffPolicy } from './outbox-backoff';

export const DOMAIN_EVENTS_QUEUE = 'domain-events';

// How often the outbox is polled (OUTBOX_POLL_MS)
const DEFAULT_POLL_MS = 1_000;
// Events claimed per poll
const BATCH_SIZE = 50;
// A claimed event is re-delivered after this if its publisher died meanwhile
const CLAIM_MS = 60_000;
// Forwarding to Redis must never hold up the database truth
const FORWARD_TIMEOUT_MS = 2_000;

export interface PublishSummary {
  claimed: number;
  published: number;
  failed: number;
  deadLettered: number;
}

/**
 * Delivers outbox events to the in-process consumers (EventHandlerRegistry).
 *
 * A setInterval poller, like the reservation sweep: no Redis needed. Safe on
 * several API instances: a batch is claimed with FOR UPDATE SKIP LOCKED and a
 * short lease (lockedUntil), so each event is handled by one instance at a
 * time; a crashed instance's lease expires and the event is retried. A failed
 * delivery is retried with exponential backoff and dead-lettered after
 * OUTBOX_MAX_ATTEMPTS. Consumers de-duplicate with inbox rows, so a redelivery
 * never repeats an effect.
 *
 * With OUTBOX_FORWARD_TO_QUEUE=true, delivered events are also pushed to the
 * Bull queue "domain-events" (job id = event id) when Redis is up; that copy is
 * best effort, Postgres stays the durable truth.
 */
@Injectable()
export class OutboxPublisherService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OutboxPublisherService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  readonly policy: BackoffPolicy = backoffPolicy();

  constructor(
    private dataSource: DataSource,
    private registry: EventHandlerRegistry,
    @Optional()
    @InjectQueue(DOMAIN_EVENTS_QUEUE)
    private readonly queue?: Queue,
  ) {}

  onApplicationBootstrap() {
    if (process.env.OUTBOX_PUBLISHER === 'off') return;
    const interval = Number(process.env.OUTBOX_POLL_MS) || DEFAULT_POLL_MS;
    this.timer = setInterval(() => {
      void this.publishPending();
    }, interval);
    // Never keep the process alive just for this
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Claim and deliver due events until none are left (or `maxBatches`). */
  async publishPending(maxBatches = 20): Promise<PublishSummary> {
    const summary: PublishSummary = {
      claimed: 0,
      published: 0,
      failed: 0,
      deadLettered: 0,
    };
    if (this.running) return summary;
    this.running = true;
    try {
      for (let batch = 0; batch < maxBatches; batch++) {
        const rows = await this.claim(BATCH_SIZE);
        if (!rows.length) break;
        summary.claimed += rows.length;
        for (const row of rows) {
          const outcome = await this.deliver(row);
          summary[outcome]++;
        }
        if (rows.length < BATCH_SIZE) break;
      }
    } catch (error) {
      this.logger.error(
        `Outbox publishing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
    return summary;
  }

  /** Lease a batch of due events to this instance (attempts counted here). */
  async claim(limit: number): Promise<OutboxRow[]> {
    const result: unknown = await this.dataSource.query(
      `UPDATE outbox_events o
          SET "lockedUntil" = now() + ($2::int * interval '1 millisecond'),
              attempts = o.attempts + 1
        WHERE o.id IN (
          SELECT id FROM outbox_events
           WHERE "publishedAt" IS NULL AND "deadLetteredAt" IS NULL
             AND "nextAttemptAt" <= now()
             AND ("lockedUntil" IS NULL OR "lockedUntil" < now())
           ORDER BY "occurredAt"
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING o.*`,
      [limit, CLAIM_MS],
    );
    return returnedRows<OutboxRow>(result).sort(
      (a, b) =>
        new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
    );
  }

  /** Deliver one claimed event and record the outcome. */
  async deliver(
    row: OutboxRow,
  ): Promise<'published' | 'failed' | 'deadLettered'> {
    const event = toDeliveredEvent(row);
    let failures: { consumer: string; error: string }[];
    try {
      failures = (await this.registry.dispatch(event)).failures;
    } catch (error) {
      failures = [
        {
          consumer: '*',
          error: error instanceof Error ? error.message : String(error),
        },
      ];
    }

    if (!failures.length) {
      await this.dataSource.query(
        `UPDATE outbox_events
            SET "publishedAt" = now(), "lockedUntil" = NULL, "lastError" = NULL
          WHERE id = $1`,
        [row.id],
      );
      await this.forward(event);
      return 'published';
    }

    const lastError = failures
      .map((f) => `${f.consumer}: ${f.error}`)
      .join('\n')
      .slice(0, 4000);
    const next = afterFailure(row.attempts, new Date(), this.policy);
    await this.dataSource.query(
      `UPDATE outbox_events
          SET "lastError" = $2, "lockedUntil" = NULL, "nextAttemptAt" = $3,
              "deadLetteredAt" = CASE WHEN $4::boolean THEN now() ELSE NULL END
        WHERE id = $1`,
      [row.id, lastError, next.nextAttemptAt, next.deadLetter],
    );
    if (next.deadLetter) {
      this.logger.error(
        `Outbox event ${row.eventType} ${row.id} dead-lettered after ${row.attempts} attempts: ${lastError}`,
      );
      return 'deadLettered';
    }
    return 'failed';
  }

  /** Best-effort copy to Redis for out-of-process consumers */
  private async forward(event: ReturnType<typeof toDeliveredEvent>) {
    if (process.env.OUTBOX_FORWARD_TO_QUEUE !== 'true' || !this.queue) return;
    const status = (this.queue.client as { status?: string } | undefined)
      ?.status;
    if (status !== 'ready') return;
    try {
      await Promise.race([
        this.queue.add(event.eventType, event, {
          jobId: event.id,
          removeOnComplete: 1000,
          removeOnFail: 1000,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('timed out')),
            FORWARD_TIMEOUT_MS,
          ).unref(),
        ),
      ]);
    } catch (error) {
      this.logger.warn(
        `Could not forward event ${event.id} to Redis: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
