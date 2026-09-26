import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  NotFoundException,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint: GET /metrics (outside the /api/v1 prefix).
 * Protected by METRICS_TOKEN; see docs/operations.md.
 */
@ApiExcludeController()
@SkipThrottle({ default: true, tenant: true })
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Public()
  @Get()
  async scrape(
    @Headers('authorization') authorization: string | undefined,
    @Res() res: Response,
  ) {
    const access = this.metrics.access(authorization);
    if (access === 'disabled') throw new NotFoundException();
    if (access === 'unauthorized') {
      throw authorization
        ? new ForbiddenException('Invalid metrics token')
        : new UnauthorizedException('Metrics token required');
    }
    const { contentType, body } = await this.metrics.render();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.send(body);
  }
}
