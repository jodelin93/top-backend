import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { returnedRows } from '../../platform/outbox/event-handler.registry';

export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

export type IdempotencyBegin =
  | { state: 'started' }
  | { state: 'replay'; status: number; body: unknown }
  | { state: 'mismatch'; commandType: string }
  | { state: 'in_progress' };

export interface BeginInput {
  tenantId: string;
  key: string;
  commandType: string;
  requestHash: string;
  ttlMs: number;
}

/** Where idempotency records live (Postgres in the app, in memory in tests) */
export interface IdempotencyStore {
  begin(input: BeginInput): Promise<IdempotencyBegin>;
  complete(
    tenantId: string,
    key: string,
    status: number,
    body: unknown,
  ): Promise<void>;
  // The command failed: forget the key so the client may retry
  abandon(tenantId: string, key: string): Promise<void>;
}

// An in-progress record older than this belongs to a crashed request and may be taken over
export const IDEMPOTENCY_STALE_MS = 5 * 60_000;

/**
 * idempotency_records in Postgres. The unique (tenantId, key) row is the lock:
 * the first request inserts it, concurrent duplicates find it in progress.
 */
@Injectable()
export class PgIdempotencyStore implements IdempotencyStore {
  constructor(private dataSource: DataSource) {}

  async begin(input: BeginInput, retries = 3): Promise<IdempotencyBegin> {
    const inserted = returnedRows(
      await this.dataSource.query(
        `INSERT INTO idempotency_records ("tenantId", key, "commandType", "requestHash", "expiresAt")
         VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 millisecond'))
         ON CONFLICT ("tenantId", key) DO UPDATE
            SET "commandType" = EXCLUDED."commandType",
                "requestHash" = EXCLUDED."requestHash",
                "responseStatus" = NULL,
                "responseBody" = NULL,
                "createdAt" = now(),
                "expiresAt" = EXCLUDED."expiresAt"
          WHERE idempotency_records."expiresAt" < now()
             OR (idempotency_records."responseStatus" IS NULL
                 AND idempotency_records."createdAt" < now() - ($6::int * interval '1 millisecond'))
         RETURNING id`,
        [
          input.tenantId,
          input.key,
          input.commandType,
          input.requestHash,
          input.ttlMs,
          IDEMPOTENCY_STALE_MS,
        ],
      ),
    );
    if (inserted.length) return { state: 'started' };

    const [existing] = await this.dataSource.query<
      {
        commandType: string;
        requestHash: string;
        responseStatus: number | null;
        responseBody: unknown;
      }[]
    >(
      `SELECT "commandType", "requestHash", "responseStatus", "responseBody"
         FROM idempotency_records WHERE "tenantId" = $1 AND key = $2`,
      [input.tenantId, input.key],
    );
    // Deleted in between (the first attempt failed): let this one run
    if (!existing) {
      if (retries <= 0) return { state: 'in_progress' };
      return this.begin(input, retries - 1);
    }
    if (existing.requestHash.trim() !== input.requestHash) {
      return { state: 'mismatch', commandType: existing.commandType };
    }
    if (existing.responseStatus === null) return { state: 'in_progress' };
    return {
      state: 'replay',
      status: existing.responseStatus,
      body: existing.responseBody,
    };
  }

  async complete(tenantId: string, key: string, status: number, body: unknown) {
    await this.dataSource.query(
      `UPDATE idempotency_records SET "responseStatus" = $3, "responseBody" = $4::jsonb
        WHERE "tenantId" = $1 AND key = $2`,
      [tenantId, key, status, JSON.stringify(body ?? null)],
    );
  }

  async abandon(tenantId: string, key: string) {
    await this.dataSource.query(
      `DELETE FROM idempotency_records
        WHERE "tenantId" = $1 AND key = $2 AND "responseStatus" IS NULL`,
      [tenantId, key],
    );
  }
}
