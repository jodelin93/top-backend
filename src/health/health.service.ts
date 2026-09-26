import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bull';
import type { Queue } from 'bull';
import { DataSource } from 'typeorm';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isStrictEnv } from '../config/environment';
import { bearerMatches } from '../metrics/metrics.service';

const CHECK_TIMEOUT_MS = 4000; // below the 5s Docker HEALTHCHECK timeout

export type CheckStatus = 'up' | 'down';

export interface DependencyCheck {
  status: CheckStatus;
  latencyMs?: number;
  error?: string;
  [key: string]: unknown;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'error';
  version: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
  checks: {
    database: DependencyCheck;
    redis: DependencyCheck;
  };
}

function resolveVersion(): string {
  if (process.env.APP_VERSION) {
    return process.env.APP_VERSION;
  }
  try {
    // dist/health -> package.json at the project root (also src/health under ts-node)
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ latencyMs: number; result: T }> {
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out after ${CHECK_TIMEOUT_MS}ms`)),
      CHECK_TIMEOUT_MS,
    );
  });
  try {
    const result = await Promise.race([fn(), timeout]);
    return { latencyMs: Date.now() - start, result };
  } finally {
    clearTimeout(timer);
  }
}

const errorMessage = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// Driver errors can carry hostnames: only returned in development/test
const exposeErrors = () => !isStrictEnv();

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);
  private readonly version = resolveVersion();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    // Any registered queue shares the Bull Redis connection settings
    @InjectQueue('sync') private readonly queue: Queue,
  ) {}

  /**
   * Whether the caller may see the detailed report (version, environment, pool
   * stats, per-dependency checks): with METRICS_TOKEN set, only callers sending
   * "Authorization: Bearer <METRICS_TOKEN>"; without a token, only in
   * development/test. Everyone else gets { status } only.
   */
  canSeeDetails(authorization: string | undefined): boolean {
    const token = this.config.get<string>('METRICS_TOKEN');
    if (token) return bearerMatches(authorization, token);
    return !isStrictEnv(this.config.get<string>('NODE_ENV'));
  }

  async check(): Promise<HealthReport> {
    const [database, redis] = await Promise.all([
      this.checkDatabase(),
      this.checkRedis(),
    ]);

    // The database is critical (-> 503). Redis only backs background jobs,
    // so an outage degrades the service but does not take it out of rotation.
    const status =
      database.status === 'down'
        ? 'error'
        : redis.status === 'down'
          ? 'degraded'
          : 'ok';

    return {
      status,
      version: this.version,
      environment: process.env.NODE_ENV ?? 'development',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      checks: { database, redis },
    };
  }

  private async checkDatabase(): Promise<DependencyCheck> {
    try {
      const { latencyMs } = await timed(() =>
        this.dataSource.query('SELECT 1'),
      );
      return { status: 'up', latencyMs, pool: this.poolStats() };
    } catch (err) {
      return { status: 'down', error: this.failure('database', err) };
    }
  }

  private async checkRedis(): Promise<DependencyCheck> {
    try {
      const { latencyMs } = await timed(() => this.queue.client.ping());
      return { status: 'up', latencyMs, critical: false };
    } catch (err) {
      return {
        status: 'down',
        error: this.failure('redis', err),
        critical: false,
      };
    }
  }

  private failure(dependency: string, err: unknown): string {
    const message = errorMessage(err);
    this.logger.warn(`Health check failed for ${dependency}: ${message}`);
    return exposeErrors() ? message : 'unavailable';
  }

  /** node-postgres pool counters, useful to spot connection exhaustion. */
  private poolStats(): Record<string, number> | undefined {
    const pool = (
      this.dataSource.driver as unknown as {
        master?: {
          totalCount?: number;
          idleCount?: number;
          waitingCount?: number;
        };
      }
    ).master;
    if (!pool || typeof pool.totalCount !== 'number') {
      return undefined;
    }
    return {
      total: pool.totalCount,
      idle: pool.idleCount ?? 0,
      waiting: pool.waitingCount ?? 0,
    };
  }
}
