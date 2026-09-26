import { HttpException } from '@nestjs/common';

/**
 * Machine-readable error codes (spec §24). Every error response carries
 * `code` (stable UPPER_SNAKE_CASE) and `retryable` next to the human message.
 *
 * Services can set their own code: `throw new ConflictException({ message, code: 'SHIFT_CLOSED' })`
 * or use businessError(). Otherwise the code is derived from the status and, for
 * well-known messages, from the message. Codes are never removed or renamed once
 * clients may rely on them; statuses are unchanged by this layer.
 */

const STATUS_CODES: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHENTICATED',
  402: 'PAYMENT_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  406: 'NOT_ACCEPTABLE',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  410: 'GONE',
  412: 'PRECONDITION_FAILED',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE',
  428: 'PRECONDITION_REQUIRED',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

// Well-known messages thrown across the codebase → a more precise code
const MESSAGE_CODES: { pattern: RegExp; code: string }[] = [
  {
    pattern: /insufficient stock|not enough stock/i,
    code: 'INSUFFICIENT_STOCK',
  },
  {
    pattern: /no open shift|shift is (already )?closed|shift is not open/i,
    code: 'SHIFT_NOT_OPEN',
  },
  { pattern: /already has an open shift/i, code: 'SHIFT_ALREADY_OPEN' },
  { pattern: /credit limit/i, code: 'CREDIT_LIMIT_EXCEEDED' },
  {
    pattern: /approval token|approval (is )?required|must be approved/i,
    code: 'APPROVAL_REQUIRED',
  },
  { pattern: /already exists|duplicate/i, code: 'ALREADY_EXISTS' },
  { pattern: /in use and cannot be deleted/i, code: 'IN_USE' },
  {
    pattern: /^cannot \w+ an? .+ that is \w+/i,
    code: 'INVALID_STATE_TRANSITION',
  },
  {
    pattern: /offline lease|device (has been )?revoked/i,
    code: 'DEVICE_NOT_AUTHORIZED',
  },
  { pattern: /two-factor|mfa/i, code: 'MFA_REQUIRED' },
];

// Postgres errors worth retrying (serialization failure, deadlock, lock timeout)
const TRANSIENT_PG_CODES = new Set(['40001', '40P01', '55P03']);

export const RETRYABLE_STATUSES = new Set([408, 425, 429, 502, 503, 504]);

export function isStableCode(value: unknown): value is string {
  return (
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value)
  );
}

export function defaultErrorCode(
  status: number,
  message: string | string[],
  body: Record<string, unknown> = {},
): string {
  if (status === 400 && Array.isArray(message)) {
    return 'VALIDATION_FAILED';
  }
  if (status === 403) {
    if (body.approvable === true) return 'APPROVAL_REQUIRED';
    if (Array.isArray(body.missingPermissions)) return 'PERMISSION_DENIED';
  }
  if (status >= 400 && status < 500 && typeof message === 'string') {
    const known = MESSAGE_CODES.find((m) => m.pattern.test(message));
    if (known) return known.code;
  }
  return (
    STATUS_CODES[status] ??
    (status >= 500 ? 'INTERNAL_ERROR' : 'REQUEST_FAILED')
  );
}

export function defaultRetryable(status: number, code: string): boolean {
  if (
    code === 'TRANSIENT_DATABASE_ERROR' ||
    code === 'IDEMPOTENCY_IN_PROGRESS'
  ) {
    return true;
  }
  if (RETRYABLE_STATUSES.has(status)) return true;
  // Unexpected server errors may be retried safely by clients that send an Idempotency-Key
  return status >= 500 && status !== 501;
}

/** Code of a non-HTTP error (driver errors) */
export function internalErrorCode(exception: unknown): string {
  const driverCode = (
    exception as { driverError?: { code?: unknown }; code?: unknown } | null
  )?.driverError?.code;
  if (typeof driverCode === 'string' && TRANSIENT_PG_CODES.has(driverCode)) {
    return 'TRANSIENT_DATABASE_ERROR';
  }
  return 'INTERNAL_ERROR';
}

/**
 * Throw with an explicit code, e.g.
 * `throw businessError(ConflictException, 'SHIFT_CLOSED', 'This shift is already closed')`.
 */
export function businessError<E extends HttpException>(
  Exception: new (body: Record<string, unknown>) => E,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): E {
  return new Exception({ message, code, ...extra });
}
