import { ApiTags } from '@nestjs/swagger';
import { Controller, Get, Headers, HttpStatus, Res } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { HealthReport, HealthService } from './health.service';

/**
 * Health endpoints (public, not rate limited):
 * - GET /health       readiness: DB (critical) + Redis (non-critical); 503 when the DB is down.
 *                      Anonymous callers get { status } only; the full report (version,
 *                      pool stats, per-dependency checks) needs the METRICS_TOKEN bearer
 *                      token (or development/test without a token).
 * - GET /health/live  liveness: the process is up and serving HTTP, no dependency checks
 */
@Public()
@SkipThrottle()
@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  async check(
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthReport | Pick<HealthReport, 'status'>> {
    const report = await this.healthService.check();
    res.setHeader('Cache-Control', 'no-store');
    if (report.status === 'error') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return this.healthService.canSeeDetails(authorization)
      ? report
      : { status: report.status };
  }

  @Get('live')
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }
}
