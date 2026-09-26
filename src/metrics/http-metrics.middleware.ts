import type { NextFunction, Request, Response } from 'express';
import {
  httpRequestDuration,
  httpRequestsTotal,
  offlineSyncEventsTotal,
  salesCompletedTotal,
} from './metrics.registry';

/**
 * Route label: the matched route pattern (/api/v1/sales/:id), never the raw URL,
 * so ids don't explode the number of series.
 */
export function routeLabel(req: Request): string {
  const { route } = req as unknown as { route?: { path?: unknown } };
  const path: unknown = route?.path;
  if (typeof path === 'string') {
    return `${req.baseUrl ?? ''}${path}`;
  }
  return 'unmatched';
}

const SALES_ROUTE = /\/sales$/;

export function httpMetricsMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const route = routeLabel(req);
    if (route.endsWith('/metrics')) return;
    const labels = {
      method: req.method,
      route,
      status: String(res.statusCode),
    };
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, seconds);

    // Checkout (201 = committed). Offline-captured sales are uploads from a till queue.
    if (req.method === 'POST' && SALES_ROUTE.test(route)) {
      const body = req.body as { offlineCapturedAt?: unknown } | undefined;
      const offline = !!body?.offlineCapturedAt;
      if (res.statusCode < 300) {
        salesCompletedTotal.inc({ channel: offline ? 'offline' : 'online' });
        if (offline) offlineSyncEventsTotal.inc({ event: 'sale_uploaded' });
      } else if (offline && res.statusCode >= 400 && res.statusCode < 500) {
        offlineSyncEventsTotal.inc({ event: 'sale_rejected' });
      }
    }
  });
  next();
}
