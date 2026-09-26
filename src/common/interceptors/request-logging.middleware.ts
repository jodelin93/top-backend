import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { useJsonLogs } from '../../config/logger.config';

export const REQUEST_ID_HEADER = 'X-Request-Id';

// Accept a caller-supplied id (e.g. from a load balancer) only if it looks sane
const VALID_REQUEST_ID = /^[\w\-.:]{1,128}$/;

type RequestWithContext = Request & {
  requestId?: string;
  user?: { id?: string; sub?: string; tenantId?: string | null };
};

/**
 * Routes whose last path segment is a bearer capability (signed download /
 * receipt links): anyone holding the URL can use it, so it must never reach logs.
 */
const TOKEN_PATH = /(\/(?:exports\/download|public\/receipts))\/[^/?#]+/g;

/**
 * Path for logs: query string dropped (it may carry filters or secrets) and
 * token segments of capability URLs replaced by ":token".
 */
export function redactPath(url: string): string {
  return url.split('?')[0].replace(TOKEN_PATH, '$1/:token');
}

/** The id assigned to this request by requestLoggingMiddleware. */
export function getRequestId(request: Request): string | undefined {
  return (request as RequestWithContext).requestId;
}

const logger = new Logger('HTTP');

/**
 * Express middleware (runs before guards, so it also sees 401/403/429 responses):
 * - propagates or generates an X-Request-Id and echoes it on the response
 * - logs one line per request once the response is sent: JSON in production,
 *   human-readable in development
 */
export function requestLoggingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const request = req as RequestWithContext;
  const incoming = req.get(REQUEST_ID_HEADER);
  const requestId =
    incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  request.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs =
      Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100;
    const status = res.statusCode;
    const path = redactPath(req.originalUrl);
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'log';
    // Health probes run every few seconds; keep them out of the normal log stream
    const isProbe = path.endsWith('/health');

    const entry = {
      requestId,
      method: req.method,
      path,
      status,
      durationMs,
      userId: request.user?.id ?? request.user?.sub,
      tenantId: request.user?.tenantId ?? undefined,
      ip: req.ip,
      userAgent: req.get('user-agent'),
    };

    const who = entry.userId ? ` user=${entry.userId}` : '';
    const message = useJsonLogs()
      ? entry
      : `${req.method} ${path} ${status} ${durationMs}ms${who} [${requestId}]`;

    if (isProbe && status < 400) {
      logger.debug(message);
    } else {
      logger[level](message);
    }
  });

  next();
}
