import { createHash } from 'crypto';
import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { instanceToPlain } from 'class-transformer';
import type { Request, Response } from 'express';
import { from, Observable, of } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import { IDEMPOTENCY_STORE, type IdempotencyStore } from './idempotency.store';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';
export const IDEMPOTENT_METADATA = 'idempotent:command';

// How long a stored outcome is replayed (IDEMPOTENCY_TTL_HOURS, default 24 h)
const ttlMs = () =>
  (Number(process.env.IDEMPOTENCY_TTL_HOURS) || 24) * 3_600_000;

const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

export interface IdempotentOptions {
  commandType: string;
}

/** JSON with object keys sorted, so equal bodies hash equally */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function requestHash(
  commandType: string,
  method: string,
  path: string,
  body: unknown,
  userId = '',
): string {
  // The user is part of the request: another member of the store reusing the
  // key gets 409 IDEMPOTENCY_KEY_REUSED, never a replay of someone else's response
  return createHash('sha256')
    .update(`${commandType}\n${method.toUpperCase()}\n${path}\n`)
    .update(`user:${userId}\n`)
    .update(canonicalJson(body ?? null))
    .digest('hex');
}

/**
 * Generic command idempotency (see docs/idempotency.md). With an
 * `Idempotency-Key` header, the first request runs and its response is stored;
 * a retry with the same key and the same request gets that response again
 * (header Idempotent-Replayed: true) without running the command twice.
 *
 * - same key, different request (body, path or command) → 409 IDEMPOTENCY_KEY_REUSED
 * - same key while the first request is still running  → 409 IDEMPOTENCY_IN_PROGRESS (retry later)
 * - the command fails → nothing is stored, the key can be retried
 * - no header → the command runs normally
 *
 * Keys are scoped per store and bound to the user who sent them (the user is
 * part of the request hash); records are kept IDEMPOTENCY_TTL_HOURS (24 h).
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private reflector: Reflector,
    @Inject(IDEMPOTENCY_STORE) private store: IdempotencyStore,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.get<IdempotentOptions | undefined>(
      IDEMPOTENT_METADATA,
      context.getHandler(),
    );
    const http = context.switchToHttp();
    const request = http.getRequest<
      Request & {
        user?: { tenantId?: string | null; id?: string; sub?: string };
      }
    >();
    const response = http.getResponse<Response>();
    const key = request.header?.(IDEMPOTENCY_KEY_HEADER)?.trim();
    const tenantId = request.user?.tenantId;
    if (!options || !key || !tenantId) return next.handle();
    if (!KEY_PATTERN.test(key)) {
      throw new BadRequestException({
        message: 'Idempotency-Key must be 1 to 255 visible ASCII characters',
        error: 'Bad Request',
        code: 'IDEMPOTENCY_KEY_INVALID',
      });
    }

    const hash = requestHash(
      options.commandType,
      request.method,
      (request.originalUrl ?? request.url ?? '').split('?')[0],
      request.body,
      request.user?.id ?? request.user?.sub ?? '',
    );

    return from(
      this.store.begin({
        tenantId,
        key,
        commandType: options.commandType,
        requestHash: hash,
        ttlMs: ttlMs(),
      }),
    ).pipe(
      mergeMap((begun) => {
        switch (begun.state) {
          case 'mismatch':
            throw new ConflictException({
              message:
                'This Idempotency-Key was already used for a different request',
              error: 'Conflict',
              code: 'IDEMPOTENCY_KEY_REUSED',
              retryable: false,
            });
          case 'in_progress':
            throw new ConflictException({
              message:
                'A request with this Idempotency-Key is still in progress',
              error: 'Conflict',
              code: 'IDEMPOTENCY_IN_PROGRESS',
              retryable: true,
            });
          case 'replay':
            response.status(begun.status);
            response.setHeader(IDEMPOTENT_REPLAYED_HEADER, 'true');
            return of(begun.body);
          default:
            return next.handle().pipe(
              mergeMap(async (result: unknown) => {
                // Stored as the client saw it (@Exclude fields removed)
                const body = instanceToPlain(result) as unknown;
                await this.store.complete(
                  tenantId,
                  key,
                  response.statusCode,
                  body ?? null,
                );
                return result;
              }),
              catchError(async (error: unknown) => {
                await this.store.abandon(tenantId, key).catch(() => undefined);
                throw error;
              }),
            );
        }
      }),
    );
  }
}
