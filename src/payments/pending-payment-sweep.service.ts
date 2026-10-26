import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { LOCKS, runExclusive } from '../platform/scheduling';
import { PaymentsService } from './payments.service';

const SWEEP_INTERVAL_MS = 2 * 60_000;
// Left alone this long first: the provider's webhook normally answers sooner
const STALE_AFTER = `interval '2 minutes'`;
const BATCH = 50;

/**
 * Payments still open at a provider (a terminal, mobile money...) whose answer
 * never came (a lost webhook, one that failed): every two minutes, one API
 * instance asks the provider for their status, so a sale paid in fact does not
 * stay "waiting for payment" with its stock reserved. PAYMENT_PENDING_SWEEP=off
 * turns it off. The manual provider confirms by hand: never asked.
 */
@Injectable()
export class PendingPaymentSweepService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PendingPaymentSweepService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private dataSource: DataSource,
    private payments: PaymentsService,
  ) {}

  onApplicationBootstrap() {
    if (process.env.PAYMENT_PENDING_SWEEP === 'off') return;
    this.timer = setInterval(() => {
      void runExclusive(this.dataSource, LOCKS.pendingPayments, () =>
        this.sweep(),
      ).catch((error: unknown) =>
        this.logger.error(`Pending payment check failed: ${String(error)}`),
      );
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ask the provider about each stale open payment. Returns how many were asked. */
  async sweep(): Promise<number> {
    const rows = await this.dataSource.query<
      { id: string; tenantId: string }[]
    >(
      `SELECT p.id, p."tenantId" FROM payments p
         JOIN sales s ON s.id = p."saleId"
        WHERE s.status = 'payment_pending'
          AND p.status IN ('initiated', 'pending', 'authorized', 'unknown')
          AND p.provider IS NOT NULL AND p.provider <> 'manual'
          AND p.updated_at < NOW() - ${STALE_AFTER}
          AND (p."lastCheckedAt" IS NULL OR p."lastCheckedAt" < NOW() - ${STALE_AFTER})
        ORDER BY p."lastCheckedAt" NULLS FIRST
        LIMIT ${BATCH}`,
    );
    for (const row of rows) {
      try {
        await this.payments.lookup(row.tenantId, row.id);
      } catch (error) {
        this.logger.warn(
          `Could not check payment ${row.id}: ${String(error)}`.slice(0, 500),
        );
      }
    }
    return rows.length;
  }
}
