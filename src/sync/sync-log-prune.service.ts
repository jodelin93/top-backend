import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { errorMessage, LOCKS, scheduleDaily } from '../platform/scheduling';
import { CHANGE_LOG_RETENTION } from './sync-cursor';

// Rows deleted per statement (short transactions, no long lock on the table)
const PRUNE_BATCH = 10_000;

/**
 * Deletes sync_change_log rows no accepted cursor can still need
 * (`CHANGE_LOG_RETENTION`, 8 days, set in sync-cursor.ts; the same rule
 * SyncService applies to a store after a full download).
 *
 * The rule: a cursor is only accepted for 7 days (MAX_CURSOR_AGE_MS); an
 * older one gets a full download instead. A cursor issued at time T reads
 * the rows with seq > s (written after T) plus the rows with seq <= s whose
 * transaction was still running at T (txid >= x). So no accepted cursor needs
 * a row written more than 7 days ago, plus the length of the longest
 * transaction running when it was issued: 8 days keeps a full day for that.
 * Each store's newest row is always kept, so max(seq) — the `s` of a fresh
 * cursor — never goes back.
 *
 * Runs once a day on one API instance (advisory lock); SYNC_LOG_PRUNE=off
 * disables it.
 */
@Injectable()
export class SyncLogPruneService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SyncLogPruneService.name);
  private stop: (() => void) | null = null;

  constructor(private dataSource: DataSource) {}

  onApplicationBootstrap() {
    this.stop = scheduleDaily(this.dataSource, {
      lockKey: LOCKS.syncLogPrune,
      envSwitch: 'SYNC_LOG_PRUNE',
      job: () => this.prune(),
      onError: (error) =>
        this.logger.error(`Change log prune failed: ${errorMessage(error)}`),
    });
  }

  onModuleDestroy() {
    this.stop?.();
    this.stop = null;
  }

  /** Delete every prunable row, in batches. Returns the number deleted. */
  async prune(): Promise<number> {
    let total = 0;
    for (;;) {
      const result: unknown = await this.dataSource.query(
        `DELETE FROM sync_change_log
          WHERE seq IN (
            SELECT o.seq FROM sync_change_log o
             WHERE o.changed_at < now() - $1::interval
               AND o.seq < (SELECT max(m.seq) FROM sync_change_log m
                             WHERE m."tenantId" = o."tenantId")
             LIMIT ${PRUNE_BATCH})`,
        [CHANGE_LOG_RETENTION],
      );
      // node-postgres answers a DELETE with [rows, affected count]
      const deleted = Array.isArray(result) ? Number(result[1] ?? 0) : 0;
      total += deleted;
      if (deleted < PRUNE_BATCH) break;
    }
    if (total > 0) this.logger.log(`Pruned ${total} change log row(s)`);
    return total;
  }
}
