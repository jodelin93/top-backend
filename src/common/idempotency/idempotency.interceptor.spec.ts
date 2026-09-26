// Jest mocks are asserted on as detached methods
/* eslint-disable @typescript-eslint/unbound-method */
import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, Subject, throwError } from 'rxjs';
import {
  canonicalJson,
  IdempotencyInterceptor,
  IDEMPOTENT_METADATA,
  requestHash,
} from './idempotency.interceptor';
import { Idempotent } from './idempotent.decorator';
import type {
  BeginInput,
  IdempotencyBegin,
  IdempotencyStore,
} from './idempotency.store';

/** Same semantics as PgIdempotencyStore, in memory */
class MemoryStore implements IdempotencyStore {
  rows = new Map<
    string,
    { hash: string; commandType: string; status?: number; body?: unknown }
  >();

  begin(input: BeginInput): Promise<IdempotencyBegin> {
    const id = `${input.tenantId}|${input.key}`;
    const row = this.rows.get(id);
    if (!row) {
      this.rows.set(id, {
        hash: input.requestHash,
        commandType: input.commandType,
      });
      return Promise.resolve({ state: 'started' });
    }
    if (row.hash !== input.requestHash) {
      return Promise.resolve({
        state: 'mismatch',
        commandType: row.commandType,
      });
    }
    if (row.status === undefined) {
      return Promise.resolve({ state: 'in_progress' });
    }
    return Promise.resolve({
      state: 'replay',
      status: row.status,
      body: row.body,
    });
  }

  complete(tenantId: string, key: string, status: number, body: unknown) {
    const row = this.rows.get(`${tenantId}|${key}`)!;
    row.status = status;
    row.body = body;
    return Promise.resolve();
  }

  abandon(tenantId: string, key: string) {
    const id = `${tenantId}|${key}`;
    if (this.rows.get(id)?.status === undefined) this.rows.delete(id);
    return Promise.resolve();
  }
}

class Controller {
  @Idempotent('expense.pay')
  pay() {}

  plain() {}
}

function contextFor(
  handler: () => void,
  request: {
    key?: string;
    body?: unknown;
    url?: string;
    tenantId?: string | null;
    userId?: string;
  },
) {
  const headers: Record<string, string> = {};
  const response = {
    statusCode: 200,
    status: jest.fn(function (this: { statusCode: number }, code: number) {
      this.statusCode = code;
      return this;
    }),
    setHeader: jest.fn((name: string, value: string) => {
      headers[name] = value;
    }),
  };
  const req = {
    method: 'POST',
    originalUrl: request.url ?? '/api/v1/expenses/e1/pay',
    body: request.body ?? { reference: 'R1' },
    user: {
      tenantId: request.tenantId === undefined ? 't1' : request.tenantId,
      id: request.userId ?? 'u1',
    },
    header: (name: string) =>
      name.toLowerCase() === 'idempotency-key' ? request.key : undefined,
  };
  const context = {
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return { context, response, headers };
}

const handlerReturning = (value: unknown, status = 200) => {
  const handle = jest.fn(() => of(value));
  return { handle, status } as unknown as CallHandler & {
    handle: jest.Mock;
  };
};

describe('IdempotencyInterceptor', () => {
  let store: MemoryStore;
  let interceptor: IdempotencyInterceptor;
  const pay = Object.getOwnPropertyDescriptor(Controller.prototype, 'pay')!
    .value as () => void;
  const plain = Object.getOwnPropertyDescriptor(Controller.prototype, 'plain')!
    .value as () => void;

  beforeEach(() => {
    store = new MemoryStore();
    interceptor = new IdempotencyInterceptor(new Reflector(), store);
  });

  const run = (
    handler: () => void,
    request: Parameters<typeof contextFor>[1],
    next: CallHandler,
  ) => {
    const ctx = contextFor(handler, request);
    return {
      ...ctx,
      result: lastValueFrom(interceptor.intercept(ctx.context, next)),
    };
  };

  it('declares the command type on the route', () => {
    expect(Reflect.getMetadata(IDEMPOTENT_METADATA, pay)).toEqual({
      commandType: 'expense.pay',
    });
  });

  it('runs the command once and replays the stored response', async () => {
    const next = handlerReturning({ id: 'e1', status: 'paid' });
    const first = run(pay, { key: 'k-1' }, next);
    await expect(first.result).resolves.toEqual({ id: 'e1', status: 'paid' });

    const retry = run(pay, { key: 'k-1' }, next);
    await expect(retry.result).resolves.toEqual({ id: 'e1', status: 'paid' });
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(retry.response.status).toHaveBeenCalledWith(200);
    expect(retry.headers['Idempotent-Replayed']).toBe('true');
  });

  it("never replays another user's response for the same key", async () => {
    const next = handlerReturning({ id: 'e1', secret: 'for u1 only' });
    await run(pay, { key: 'k-u', userId: 'u1' }, next).result;
    const other = run(pay, { key: 'k-u', userId: 'u2' }, next);
    await expect(other.result).rejects.toBeInstanceOf(ConflictException);
    expect(next.handle).toHaveBeenCalledTimes(1);
  });

  it('replays the original status code', async () => {
    const next = handlerReturning({ id: 'e2' });
    const first = run(pay, { key: 'k-201' }, next);
    first.response.statusCode = 201;
    await first.result;
    const retry = run(pay, { key: 'k-201' }, next);
    await retry.result;
    expect(retry.response.status).toHaveBeenCalledWith(201);
  });

  it('409 IDEMPOTENCY_KEY_REUSED when the same key comes with another request', async () => {
    const next = handlerReturning({ ok: true });
    await run(pay, { key: 'k-2', body: { amount: 1 } }, next).result;
    const other = run(pay, { key: 'k-2', body: { amount: 2 } }, next);
    await expect(other.result).rejects.toBeInstanceOf(ConflictException);
    await other.result.catch((error: ConflictException) =>
      expect(error.getResponse()).toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
        retryable: false,
      }),
    );
    // Another path (another expense) with the same key is also a mismatch
    const otherPath = run(
      pay,
      { key: 'k-2', body: { amount: 1 }, url: '/api/v1/expenses/e9/pay' },
      next,
    );
    await expect(otherPath.result).rejects.toBeInstanceOf(ConflictException);
    expect(next.handle).toHaveBeenCalledTimes(1);
  });

  it('409 IDEMPOTENCY_IN_PROGRESS for a concurrent duplicate', async () => {
    const pending = new Subject<unknown>();
    const slow = {
      handle: jest.fn(() => pending.asObservable()),
    } as unknown as CallHandler;
    const first = run(pay, { key: 'k-3' }, slow);
    // Let the first request claim the key
    await new Promise((resolve) => setImmediate(resolve));

    const duplicate = run(pay, { key: 'k-3' }, slow);
    await duplicate.result.then(
      () => {
        throw new Error('expected a conflict');
      },
      (error: ConflictException) =>
        expect(error.getResponse()).toMatchObject({
          code: 'IDEMPOTENCY_IN_PROGRESS',
          retryable: true,
        }),
    );

    pending.next({ done: true });
    pending.complete();
    await expect(first.result).resolves.toEqual({ done: true });
  });

  it('forgets the key when the command fails, so it can be retried', async () => {
    const failing = {
      handle: jest.fn(() => throwError(() => new Error('no open shift'))),
    } as unknown as CallHandler;
    await expect(run(pay, { key: 'k-4' }, failing).result).rejects.toThrow(
      'no open shift',
    );
    expect(store.rows.size).toBe(0);

    const next = handlerReturning({ ok: true });
    await expect(run(pay, { key: 'k-4' }, next).result).resolves.toEqual({
      ok: true,
    });
  });

  it('passes through without a key, without a tenant, or on undecorated routes', async () => {
    const next = handlerReturning({ ok: true });
    await run(pay, {}, next).result;
    await run(pay, { key: 'k-5', tenantId: null }, next).result;
    await run(plain, { key: 'k-5' }, next).result;
    expect(next.handle).toHaveBeenCalledTimes(3);
    expect(store.rows.size).toBe(0);
  });

  it('rejects malformed keys', () => {
    const next = handlerReturning({ ok: true });
    const { context } = contextFor(pay, { key: 'has space' });
    expect(() => interceptor.intercept(context, next)).toThrow(
      BadRequestException,
    );
  });

  it('stores the plain response (class instances serialised)', async () => {
    class Entity {
      id = 'x';
      toJSON() {
        return { id: this.id };
      }
    }
    const next = handlerReturning(new Entity());
    await run(pay, { key: 'k-6' }, next).result;
    expect(store.rows.get('t1|k-6')?.body).toEqual({ id: 'x' });
  });
});

describe('request fingerprint', () => {
  it('ignores key order and undefined fields', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe(
      '{"a":{"c":[2,1]},"b":1}',
    );
    expect(requestHash('x', 'post', '/p', { a: 1, b: 2 })).toBe(
      requestHash('x', 'POST', '/p', { b: 2, a: 1 }),
    );
    expect(requestHash('x', 'POST', '/p', { a: 1 })).not.toBe(
      requestHash('y', 'POST', '/p', { a: 1 }),
    );
  });
});
