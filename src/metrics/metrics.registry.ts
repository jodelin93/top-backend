import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from 'prom-client';

/**
 * Prometheus metrics of this process, served by GET /metrics.
 * Module-level singletons so any code can record without injection.
 */
export const registry = new Registry();

collectDefaultMetrics({ register: registry, prefix: 'pos_' });

export const httpRequestsTotal = new Counter({
  name: 'pos_http_requests_total',
  help: 'HTTP requests by method, route pattern and status code',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'pos_http_request_duration_seconds',
  help: 'HTTP request latency by method, route pattern and status code',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const salesCompletedTotal = new Counter({
  name: 'pos_sales_completed_total',
  help: 'Sales recorded through POST /sales (channel: online, or offline = synced from a till queue)',
  labelNames: ['channel'] as const,
  registers: [registry],
});

export const offlineSyncEventsTotal = new Counter({
  name: 'pos_offline_sync_events_total',
  help: 'Offline sync activity: heartbeat, lease_renewed, lease_denied, changes_served, full_resync, sale_uploaded, sale_rejected',
  labelNames: ['event'] as const,
  registers: [registry],
});

export const devicePendingSales = new Gauge({
  name: 'pos_device_pending_sales',
  help: 'Offline sales waiting on each till, as of its last heartbeat',
  labelNames: ['tenant', 'device'] as const,
  registers: [registry],
});

export const deviceLastSeenSeconds = new Gauge({
  name: 'pos_device_last_seen_timestamp_seconds',
  help: 'Unix time of the last heartbeat of each till',
  labelNames: ['tenant', 'device'] as const,
  registers: [registry],
});

interface PoolStats {
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
}

let poolSource: (() => PoolStats | undefined) | null = null;

/** Called once the database is connected (see MetricsService). */
export function setPoolSource(source: () => PoolStats | undefined) {
  poolSource = source;
}

export const dbPoolConnections = new Gauge({
  name: 'pos_db_pool_connections',
  help: 'node-postgres pool connections by state (total, idle, waiting clients)',
  labelNames: ['state'] as const,
  registers: [registry],
  collect() {
    const pool = poolSource?.();
    if (!pool || typeof pool.totalCount !== 'number') return;
    this.set({ state: 'total' }, pool.totalCount);
    this.set({ state: 'idle' }, pool.idleCount ?? 0);
    this.set({ state: 'waiting' }, pool.waitingCount ?? 0);
  },
});

export const dbUp = new Gauge({
  name: 'pos_db_up',
  help: '1 when the last database probe (health check or metrics scrape) succeeded',
  registers: [registry],
});
