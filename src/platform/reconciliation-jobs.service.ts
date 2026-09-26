import {
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  SystemCheckResult,
  SystemCheckRun,
} from '../database/entities/system-check-run.entity';
import { AuditService } from '../audit/audit.service';
import { ReconciliationReportService } from '../reports/reconciliation.service';
import { StockProjectionService } from '../inventory/stock-projection.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OUTBOX_STALLED_AFTER_MS } from './outbox/outbox.service';
import {
  activeTenantIds,
  errorMessage,
  LOCKS,
  runExclusive,
} from './scheduling';

// The scheduler wakes up this often and runs stores whose last run is older than a day
const TICK_MS = 60 * 60_000;
const DAY_MS = 24 * 3_600_000;
// Issues kept per check in a run
const ISSUES_KEPT = 20;
// Payments captured this long ago whose sale is still not completed are flagged
const CAPTURED_UNCOMPLETED_AFTER_MINUTES = 15;
// Housekeeping retention
const INBOX_RETENTION_DAYS = 30;

/** Everything a check needs (a seam for tests) */
export interface ReconciliationDeps {
  dataSource: DataSource;
  reconciliation: Pick<ReconciliationReportService, 'run'>;
  projection: Pick<StockProjectionService, 'preview'>;
}

/**
 * Scheduled reconciliation (spec §18): once a day per store (and on demand
 * from the System events page) run the sales reconciliation checks plus
 * platform checks — captured payments whose sale is not completed, stock
 * projection drift (read-only preview) and stalled outbox events. Each run is
 * stored in system_check_runs; issues raise notifications.
 */
@Injectable()
export class ReconciliationJobsService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ReconciliationJobsService.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly deps: ReconciliationDeps;

  constructor(
    private dataSource: DataSource,
    private notifications: NotificationsService,
    auditService: AuditService,
  ) {
    // Both only need the DataSource (and audit for apply(), never called here):
    // built here so the reports and inventory modules need not export them
    this.deps = {
      dataSource,
      reconciliation: new ReconciliationReportService(dataSource),
      projection: new StockProjectionService(dataSource, auditService),
    };
  }

  onApplicationBootstrap() {
    if (process.env.RECONCILIATION_JOBS === 'off') return;
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_MS);
    this.timer.unref();
    // First pass shortly after start (runs only if a day has passed)
    setTimeout(() => void this.tick(), 60_000).unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Daily runs + housekeeping, on one instance at a time */
  async tick() {
    try {
      await runExclusive(this.dataSource, LOCKS.reconciliation, async () => {
        for (const tenantId of await activeTenantIds(this.dataSource)) {
          const [last] = await this.dataSource.query<{ startedAt: Date }[]>(
            `SELECT "startedAt" FROM system_check_runs
              WHERE "tenantId" = $1 AND trigger = 'scheduled'
              ORDER BY "startedAt" DESC LIMIT 1`,
            [tenantId],
          );
          if (
            last &&
            Date.now() - new Date(last.startedAt).getTime() < DAY_MS
          ) {
            continue;
          }
          await this.run(tenantId, 'scheduled');
        }
        await this.housekeeping();
      });
    } catch (error) {
      this.logger.error(`Reconciliation tick failed: ${errorMessage(error)}`);
    }
  }

  /** Run every check for one store now and store the outcome */
  async run(
    tenantId: string,
    trigger: 'scheduled' | 'manual',
    requestedById: string | null = null,
  ) {
    const repo = this.dataSource.getRepository(SystemCheckRun);
    const run = await repo.save(
      repo.create({
        tenantId,
        trigger,
        requestedById,
        status: 'running',
        results: [],
      }),
    );
    try {
      const results = await runChecks(this.deps, tenantId, new Date());
      run.results = results;
      run.status = results.every((r) => r.passed) ? 'passed' : 'issues';
      run.finishedAt = new Date();
      await repo.save(run);
      await this.notify(tenantId, run);
    } catch (error) {
      run.status = 'failed';
      run.error = errorMessage(error).slice(0, 2000);
      run.finishedAt = new Date();
      await repo.save(run);
      this.logger.error(
        `Reconciliation run failed for store ${tenantId}: ${run.error}`,
      );
    }
    return run;
  }

  async list(tenantId: string, limit = 30) {
    return this.dataSource.getRepository(SystemCheckRun).find({
      where: { tenantId },
      order: { startedAt: 'DESC' },
      take: Math.min(100, Math.max(1, limit)),
    });
  }

  async get(tenantId: string, id: string) {
    const run = await this.dataSource
      .getRepository(SystemCheckRun)
      .findOne({ where: { id, tenantId } });
    if (!run) throw new NotFoundException('Check run not found');
    return run;
  }

  /** Issues → notifications; a clean run clears the previous ones */
  private async notify(tenantId: string, run: SystemCheckRun) {
    const outbox = run.results.find((r) => r.key === 'outbox-stalled');
    const others = run.results.filter(
      (r) => !r.passed && r.key !== 'outbox-stalled',
    );
    if (others.length) {
      await this.notifications.notify({
        tenantId,
        type: 'reconciliation.issues',
        title: `Reconciliation found issues in ${others.length} check(s)`,
        body: others
          .map((r) => `${r.label}: ${r.issueCount} issue(s)`)
          .join('\n'),
        entityType: 'system_check_run',
        entityId: run.id,
        dedupeKey: 'reconciliation.issues',
      });
    } else {
      await this.notifications.resolve(tenantId, 'reconciliation.issues');
    }
    if (outbox && !outbox.passed) {
      await this.notifications.notify({
        tenantId,
        type: 'outbox.stalled',
        title: 'Background events are not being delivered',
        body: `${outbox.issueCount} event(s) stuck or dead-lettered. See System events.`,
        dedupeKey: 'outbox.stalled',
      });
    } else {
      await this.notifications.resolve(tenantId, 'outbox.stalled');
    }
  }

  /** Expired idempotency records, old inbox rows, old delivered events */
  async housekeeping() {
    const outboxDays = Number(process.env.OUTBOX_RETENTION_DAYS) || 30;
    await this.dataSource.query(
      `DELETE FROM idempotency_records WHERE "expiresAt" < now()`,
    );
    await this.dataSource.query(
      `DELETE FROM inbox_events WHERE "processedAt" < now() - ($1::int * interval '1 day')`,
      [INBOX_RETENTION_DAYS],
    );
    await this.dataSource.query(
      `DELETE FROM outbox_events WHERE "publishedAt" < now() - ($1::int * interval '1 day')`,
      [outboxDays],
    );
  }
}

const result = (
  key: string,
  label: string,
  issues: SystemCheckResult['issues'],
): SystemCheckResult => ({
  key,
  label,
  passed: issues.length === 0,
  issueCount: issues.length,
  issues: issues.slice(0, ISSUES_KEPT),
});

/** All checks for one store (the last day for the period-based ones) */
export async function runChecks(
  deps: ReconciliationDeps,
  tenantId: string,
  now: Date,
): Promise<SystemCheckResult[]> {
  const results: SystemCheckResult[] = [];

  // 1. Sales reconciliation (reports/reconciliation.service.ts)
  const from = new Date(now.getTime() - DAY_MS);
  const report = await deps.reconciliation.run(tenantId, {
    from: from.toISOString(),
    to: now.toISOString(),
  });
  for (const check of report.checks) {
    results.push(result(check.key, check.label, check.issues));
  }

  // 2. Captured payments whose sale is not completed
  const orphans = await deps.dataSource.query<
    { reference: string; status: string; paymentStatus: string }[]
  >(
    `SELECT s."saleNumber" AS reference, s.status::text AS status, p.status::text AS "paymentStatus"
       FROM payments p JOIN sales s ON s.id = p."saleId"
      WHERE p."tenantId" = $1
        AND p.status IN ('captured', 'completed')
        AND s.status NOT IN ('completed', 'partially_refunded', 'refunded')
        AND p.created_at < now() - ($2::int * interval '1 minute')
      LIMIT 100`,
    [tenantId, CAPTURED_UNCOMPLETED_AFTER_MINUTES],
  );
  results.push(
    result(
      'captured-payment-sale',
      'Captured payments belong to completed sales',
      orphans.map((o) => ({
        reference: o.reference,
        detail: `sale ${o.status}, payment ${o.paymentStatus}`,
      })),
    ),
  );

  // 3. Stock projections vs the movement ledger (read-only preview)
  const drift = await deps.projection.preview(tenantId);
  results.push(
    result('stock-projection', 'Stock levels match the movement ledger', [
      ...drift.levelDifferences.map((d) => ({
        reference: `${d.sku ?? d.variantId} @ ${d.locationCode ?? d.locationId}`,
        expected: d.ledger,
        actual: d.projected,
        detail: 'location stock level',
      })),
      ...drift.variantDifferences.map((d) => ({
        reference: d.sku,
        expected: d.expected,
        actual: d.current,
        detail: 'variant total',
      })),
    ]),
  );

  // 4. Outbox events stuck or dead-lettered
  const stalled = await deps.dataSource.query<
    { id: string; eventType: string; attempts: number; dead: boolean }[]
  >(
    `SELECT id, "eventType", attempts, ("deadLetteredAt" IS NOT NULL) AS dead
       FROM outbox_events
      WHERE "tenantId" = $1 AND "publishedAt" IS NULL
        AND ("deadLetteredAt" IS NOT NULL
             OR "occurredAt" < now() - ($2::int * interval '1 millisecond'))
      ORDER BY "occurredAt" LIMIT 100`,
    [tenantId, OUTBOX_STALLED_AFTER_MS],
  );
  results.push(
    result(
      'outbox-stalled',
      'Background events are delivered',
      stalled.map((e) => ({
        reference: `${e.eventType} ${e.id}`,
        detail: e.dead
          ? `dead-lettered after ${e.attempts} attempt(s)`
          : `pending, ${e.attempts} attempt(s)`,
      })),
    ),
  );

  return results;
}
