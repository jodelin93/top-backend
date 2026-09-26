import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { timingSafeEqual } from 'crypto';
import { isStrictEnv } from '../config/environment';
import { dbUp, registry, setPoolSource } from './metrics.registry';

export type MetricsAccess = 'allowed' | 'unauthorized' | 'disabled';

/**
 * Who may scrape /metrics:
 * - METRICS_TOKEN set: only requests with "Authorization: Bearer <token>";
 * - no token: open in development/test only; disabled in every strict environment
 *   (production, staging, ...: see config/environment.ts), whatever METRICS_ENABLED says;
 * - METRICS_ENABLED=false: always disabled.
 */
/** Constant-time check of an "Authorization: Bearer <token>" header. */
export function bearerMatches(
  authorization: string | undefined,
  token: string,
): boolean {
  const [type, value] = authorization?.split(' ') ?? [];
  if (type !== 'Bearer' || !value) return false;
  const a = Buffer.from(value);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function metricsAccess(
  authorization: string | undefined,
  config: { token?: string; enabled?: string; nodeEnv?: string },
): MetricsAccess {
  if (config.enabled === 'false') return 'disabled';
  if (config.token) {
    return bearerMatches(authorization, config.token)
      ? 'allowed'
      : 'unauthorized';
  }
  return isStrictEnv(config.nodeEnv) ? 'disabled' : 'allowed';
}

@Injectable()
export class MetricsService implements OnModuleInit {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  onModuleInit() {
    setPoolSource(
      () =>
        (
          this.dataSource.driver as unknown as {
            master?: {
              totalCount?: number;
              idleCount?: number;
              waitingCount?: number;
            };
          }
        ).master,
    );
  }

  access(authorization: string | undefined): MetricsAccess {
    return metricsAccess(authorization, {
      token: this.config.get<string>('METRICS_TOKEN'),
      enabled: this.config.get<string>('METRICS_ENABLED'),
      nodeEnv: this.config.get<string>('NODE_ENV'),
    });
  }

  async render(): Promise<{ contentType: string; body: string }> {
    try {
      await this.dataSource.query('SELECT 1');
      dbUp.set(1);
    } catch {
      dbUp.set(0);
    }
    return {
      contentType: registry.contentType,
      body: await registry.metrics(),
    };
  }
}
