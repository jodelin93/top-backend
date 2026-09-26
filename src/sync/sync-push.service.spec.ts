import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { Sale } from '../database/entities/sale.entity';
import { ConflictCase } from '../database/entities/conflict-case.entity';
import { TenantMembership } from '../database/entities/tenant-membership.entity';
import { SalesService } from '../sales/sales.service';
import { AuditService } from '../audit/audit.service';
import { issueLeaseClaims, signLease } from './offline-lease';
import { payloadHash } from './payload-hash';
import { SyncOperation, SyncOperationStatus } from './sync-operation.entity';
import { SyncOperationDto } from './sync.dto';
import { SyncPushService } from './sync-push.service';

const SECRET = 'push-spec-offline-lease-secret-0123456789';
const DEVICE = '11111111-1111-4111-8111-111111111111';
const REGISTER = '22222222-2222-4222-8222-222222222222';
const VARIANT = '33333333-3333-4333-8333-333333333333';
const METHOD = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';
const CASHIER = '66666666-6666-4666-8666-666666666666';

const user = { id: USER, permissions: ['pos.sell'] } as unknown as AuthUser;

const leaseToken = (
  limits = { maxSaleAmount: 0, maxSales: 0, maxTotal: 0 },
  userId = USER,
) =>
  signLease(
    issueLeaseClaims({
      tenantId: 't1',
      branchId: 'b1',
      registerId: REGISTER,
      deviceId: DEVICE,
      userId,
      permissions: ['pos.sell', 'pos.discount'],
      limits,
      issuedAt: new Date(Date.now() - 3600_000),
      expiresAt: new Date(Date.now() + 3600_000),
    }),
    SECRET,
  );

const salePayload = (key: string, extra: Record<string, unknown> = {}) => ({
  registerId: REGISTER,
  items: [{ variantId: VARIANT, quantity: 1 }],
  payments: [{ paymentMethodId: METHOD, amount: 10 }],
  idempotencyKey: key,
  offlineCapturedAt: new Date(Date.now() - 60_000).toISOString(),
  offlineNumber: `OFFLINE-${key.toUpperCase()}`,
  deviceId: DEVICE,
  ...extra,
});

const op = (
  key: string,
  seq: number,
  extra: Partial<SyncOperationDto> = {},
  payload = salePayload(key),
): SyncOperationDto => ({
  deviceOperationId: key,
  deviceSequence: seq,
  type: 'sale.create',
  schemaVersion: 1,
  payload,
  payloadHash: payloadHash(payload),
  lease: leaseToken(),
  actorId: USER,
  ...extra,
});

describe('SyncPushService', () => {
  let ops: Map<string, Partial<SyncOperation>>;
  let sales: Map<string, Partial<Sale>>;
  let cases: Partial<ConflictCase>[];
  let members: Map<string, Partial<TenantMembership>>;
  let create: jest.Mock;
  let service: SyncPushService;

  beforeEach(() => {
    ops = new Map();
    sales = new Map();
    cases = [];
    members = new Map();
    create = jest.fn(
      (_t: string, _u: AuthUser, dto: { idempotencyKey: string }) => {
        const existing = sales.get(dto.idempotencyKey);
        if (existing) return Promise.resolve(existing);
        const sale = {
          id: `sale-${dto.idempotencyKey}`,
          saleNumber: `S-${sales.size + 1}`,
          total: 10,
          discountAmount: 0,
          branchId: 'b1',
          deviceId: DEVICE,
          offlineNumber: null,
        } as unknown as Sale;
        sales.set(dto.idempotencyKey, sale);
        return Promise.resolve(sale);
      },
    );

    const insertBuilder = () => {
      let row: Partial<SyncOperation> = {};
      const qb = {
        insert: () => qb,
        into: () => qb,
        values: (v: Partial<SyncOperation>) => {
          row = v;
          return qb;
        },
        orUpdate: () => qb,
        execute: () => {
          ops.set(row.deviceOperationId!, {
            ...ops.get(row.deviceOperationId!),
            ...row,
          });
          return Promise.resolve();
        },
      };
      return qb;
    };
    const manager = {
      createQueryBuilder: insertBuilder,
      query: jest.fn((sql: string, params: unknown[]) => {
        // Register / device lookups of the tenant-isolation checks
        if (sql.includes('FROM registers')) {
          return Promise.resolve([{ branchId: 'branch-1' }]);
        }
        if (sql.includes('FROM devices')) {
          return Promise.resolve([{ registerId: null }]);
        }
        // Accepted operations under the same lease before this sequence
        const [, leaseId, seq] = params as [string, string, number];
        const prior = [...ops.values()].filter(
          (o) =>
            o.status === SyncOperationStatus.ACCEPTED &&
            o.leaseId === leaseId &&
            (o.deviceSequence ?? 0) < seq,
        );
        return Promise.resolve([
          {
            count: prior.length,
            total: String(prior.reduce((s, o) => s + Number(o.amount), 0)),
          },
        ]);
      }),
      findOne: jest.fn(
        (_entity: unknown, { where }: { where: { saleId: string } }) =>
          Promise.resolve(cases.find((c) => c.saleId === where.saleId) ?? null),
      ),
      create: (_entity: unknown, data: Partial<ConflictCase>) => data,
      save: (data: Partial<ConflictCase>) => {
        const saved = { ...data, id: `case-${cases.length + 1}` };
        cases.push(saved);
        return Promise.resolve(saved);
      },
    };
    const dataSource = {
      manager,
      transaction: (work: (m: typeof manager) => Promise<unknown>) =>
        work(manager),
      getRepository: (entity: unknown) => ({
        findOne: ({ where }: { where: Record<string, string> }) => {
          if (entity === SyncOperation) {
            return Promise.resolve(ops.get(where.deviceOperationId) ?? null);
          }
          if (entity === TenantMembership) {
            return Promise.resolve(members.get(where.userId) ?? null);
          }
          if (entity === Sale) {
            const found = where.idempotencyKey
              ? sales.get(where.idempotencyKey)
              : [...sales.values()].find((s) => s.id === where.id);
            return Promise.resolve(found ?? null);
          }
          return Promise.resolve(null);
        },
      }),
      query: jest.fn((_sql: string, [, ids]: [string, string[]]) =>
        Promise.resolve(
          ids
            .filter(
              (id) =>
                sales.has(id) ||
                ops.get(id)?.status === SyncOperationStatus.ACCEPTED,
            )
            .map((id) => ({ id })),
        ),
      ),
    };
    const config = {
      get: (key: string) =>
        key === 'OFFLINE_LEASE_SECRET' ? SECRET : undefined,
    };
    service = new SyncPushService(
      dataSource as unknown as DataSource,
      { create } as unknown as SalesService,
      config as unknown as ConfigService,
      { record: jest.fn() } as unknown as AuditService,
    );
  });

  it('applies operations in device-sequence order and acknowledges each', async () => {
    const { results } = await service.push('t1', user, {
      deviceId: DEVICE,
      operations: [op('c', 3), op('a', 1), op('b', 2)],
    });
    expect(results.map((r) => [r.deviceOperationId, r.status])).toEqual([
      ['a', 'accepted'],
      ['b', 'accepted'],
      ['c', 'accepted'],
    ]);
    expect(
      create.mock.calls.map(
        ([, , dto]) => (dto as { deviceSequence: number }).deviceSequence,
      ),
    ).toEqual([1, 2, 3]);
    // Goes through the regular sale path, keyed for idempotency
    expect((create.mock.calls as unknown[][])[0][2] as object).toMatchObject({
      idempotencyKey: 'a',
      deviceId: DEVICE,
      offlineNumber: 'OFFLINE-A',
    });
    expect(results[0]).toMatchObject({ saleId: 'sale-a', saleNumber: 'S-1' });
    expect(ops.get('a')).toMatchObject({
      status: 'accepted',
      saleId: 'sale-a',
    });
  });

  it('answers already_applied for a resent operation (lost acknowledgement)', async () => {
    const a = op('a', 1);
    await service.push('t1', user, { operations: [a] });
    const again = await service.push('t1', user, { operations: [a] });
    expect(again.results[0]).toMatchObject({
      status: 'already_applied',
      saleId: 'sale-a',
      saleNumber: 'S-1',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('answers already_applied when the sale arrived by another path', async () => {
    sales.set('a', {
      id: 'sale-a',
      saleNumber: 'S-9',
      total: 10,
      branchId: 'b1',
      deviceId: DEVICE,
    });
    const { results } = await service.push('t1', user, {
      operations: [op('a', 1)],
    });
    expect(results[0]).toMatchObject({
      status: 'already_applied',
      saleId: 'sale-a',
    });
    // The acknowledgement row is repaired
    expect(ops.get('a')?.status).toBe('accepted');
  });

  it('marks a rejected operation needs_review with the reason and carries on', async () => {
    create.mockRejectedValueOnce(new BadRequestException('Register not found'));
    const { results } = await service.push('t1', user, {
      operations: [op('a', 1), op('b', 2)],
    });
    expect(results[0]).toMatchObject({
      status: 'needs_review',
      reason: 'Register not found',
    });
    expect(results[1].status).toBe('accepted');
    expect(ops.get('a')).toMatchObject({
      status: 'needs_review',
      reason: 'Register not found',
      attempts: 1,
    });
  });

  it('needs_review for a corrupted payload, an unknown schema or an invalid sale', async () => {
    const corrupted = { ...op('a', 1), payloadHash: 'f'.repeat(64) };
    const future = op('b', 2, { schemaVersion: 99 });
    const invalid = op('c', 3, {}, salePayload('c', { items: 'nope' }));
    const { results } = await service.push('t1', user, {
      operations: [corrupted, future, invalid],
    });
    expect(results.map((r) => r.reason?.split(':')[0])).toEqual([
      'payload_hash_mismatch',
      'unsupported_schema_version',
      'invalid_payload',
    ]);
    expect(create).not.toHaveBeenCalled();
  });

  it('needs_review when an idempotency key was used for another sale', async () => {
    create.mockRejectedValueOnce(
      new ConflictException(
        'This idempotency key was already used for a different sale',
      ),
    );
    const { results } = await service.push('t1', user, {
      operations: [op('a', 1)],
    });
    expect(results[0].status).toBe('needs_review');
  });

  it('never re-applies an accepted id sent with different content', async () => {
    await service.push('t1', user, { operations: [op('a', 1)] });
    const changed = op('a', 1, {}, salePayload('a', { notes: 'changed' }));
    const { results } = await service.push('t1', user, {
      operations: [changed],
    });
    expect(results[0]).toMatchObject({
      status: 'needs_review',
      reason: 'operation_id_reused',
    });
    expect(ops.get('a')?.status).toBe('accepted');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('holds back an operation whose dependency is not applied', async () => {
    const { results } = await service.push('t1', user, {
      operations: [
        op('b', 2, { dependsOn: ['missing'] }),
        op('c', 3, { dependsOn: ['b'] }),
      ],
    });
    expect(results[0]).toMatchObject({
      status: 'pending_dependency',
      reason: 'waiting_for:missing',
    });
    expect(results[1]).toMatchObject({
      status: 'pending_dependency',
      reason: 'waiting_for:b',
    });
  });

  it('keeps the order after a transient error: later operations wait', async () => {
    create.mockRejectedValueOnce(new Error('connection reset'));
    const { results } = await service.push('t1', user, {
      operations: [op('a', 1), op('b', 2)],
    });
    expect(results.map((r) => r.status)).toEqual([
      'pending_dependency',
      'pending_dependency',
    ]);
    expect(results[1].reason).toBe('waiting_for:a');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('records a sale outside its lease and opens an offline_lease case', async () => {
    const expired = signLease(
      issueLeaseClaims({
        tenantId: 't1',
        branchId: 'b1',
        registerId: REGISTER,
        deviceId: DEVICE,
        userId: USER,
        permissions: ['pos.sell'],
        limits: { maxSaleAmount: 0, maxSales: 0, maxTotal: 0 },
        issuedAt: new Date(Date.now() - 7200_000),
        expiresAt: new Date(Date.now() - 3600_000),
      }),
      SECRET,
    );
    const { results } = await service.push('t1', user, {
      operations: [
        op('a', 1, { lease: expired }),
        op('b', 2, { lease: 'forged.token' }),
        op('c', 3, { lease: undefined }),
      ],
    });
    expect(results.map((r) => [r.status, r.leaseIssues])).toEqual([
      ['accepted', ['captured_after_lease']],
      ['accepted', ['lease_invalid']],
      ['accepted', ['lease_missing']],
    ]);
    expect(cases).toHaveLength(3);
    expect(cases[0]).toMatchObject({
      type: 'offline_lease',
      saleId: 'sale-a',
      deviceId: DEVICE,
      details: expect.objectContaining({
        issues: ['captured_after_lease'],
      }) as object,
    });
    expect(results[0].conflictCaseId).toBe('case-1');
  });

  it('counts the lease limits across operations, in sequence order', async () => {
    const lease = leaseToken({ maxSaleAmount: 0, maxSales: 2, maxTotal: 0 });
    const c = op('c', 3, { lease });
    const { results } = await service.push('t1', user, {
      operations: [c, op('a', 1, { lease }), op('b', 2, { lease })],
    });
    expect(results.map((r) => r.leaseIssues)).toEqual([
      [],
      [],
      ['over_sales_count'],
    ]);
    expect(cases).toHaveLength(1);
    // A resend does not open a second case
    const resent = await service.push('t1', user, { operations: [c] });
    expect(resent.results[0]).toMatchObject({
      status: 'already_applied',
      leaseIssues: ['over_sales_count'],
    });
    expect(cases).toHaveLength(1);
  });

  describe('cashier of record', () => {
    const actingUserOf = (call: number) =>
      (
        (create.mock.calls as unknown[][])[call][4] as {
          actingUser: { id: string; permissions: string[]; note?: string };
        }
      ).actingUser;

    const cashierLease = () => leaseToken(undefined, CASHIER);

    it("records the till's cashier (with their permissions), not the uploader", async () => {
      members.set(CASHIER, {
        userId: CASHIER,
        role: 'cashier',
        user: { status: 'active' } as TenantMembership['user'],
      });
      await service.push('t1', user, {
        operations: [op('a', 1, { actorId: CASHIER, lease: cashierLease() })],
      });
      const acting = actingUserOf(0);
      expect(acting.id).toBe(CASHIER);
      expect(acting.permissions).toContain('pos.sell');
      expect(acting.note).toBeUndefined();
    });

    it('never gives the cashier of record more than the uploader holds', async () => {
      members.set(CASHIER, {
        userId: CASHIER,
        role: 'manager',
        user: { status: 'active' } as TenantMembership['user'],
      });
      await service.push('t1', user, {
        operations: [op('a', 1, { actorId: CASHIER, lease: cashierLease() })],
      });
      // The manager could override discounts; the uploader only sells
      expect(actingUserOf(0)).toEqual({
        id: CASHIER,
        permissions: ['pos.sell'],
      });
    });

    it('records the uploader when no lease on this till vouches for the cashier', async () => {
      members.set(CASHIER, {
        userId: CASHIER,
        role: 'manager',
        user: { status: 'active' } as TenantMembership['user'],
      });
      await service.push('t1', user, {
        operations: [
          // The uploader's own lease, a manager named as the cashier
          op('a', 1, { actorId: CASHIER }),
          op('b', 2, { actorId: CASHIER, lease: undefined }),
        ],
      });
      for (const call of [0, 1]) {
        expect(actingUserOf(call)).toMatchObject({
          id: USER,
          permissions: ['pos.sell'],
          note: expect.stringContaining('no lease') as string,
        });
      }
    });

    it('falls back to the uploader with a note when the cashier is not an active member', async () => {
      members.set(CASHIER, {
        userId: CASHIER,
        role: 'cashier',
        user: { status: 'suspended' } as TenantMembership['user'],
      });
      await service.push('t1', user, {
        operations: [
          op('a', 1, { actorId: CASHIER, lease: cashierLease() }),
          op('b', 2, { actorId: undefined }),
        ],
      });
      expect(actingUserOf(0)).toMatchObject({
        id: USER,
        note: expect.stringContaining('not an active member') as string,
      });
      expect(actingUserOf(1)).toMatchObject({
        id: USER,
        note: expect.stringContaining('No cashier') as string,
      });
    });

    it('uses the uploader as is when they rang the sale up', async () => {
      await service.push('t1', user, { operations: [op('a', 1)] });
      expect(actingUserOf(0)).toEqual({ id: USER, permissions: ['pos.sell'] });
    });
  });

  describe('offline fields and capture time', () => {
    it('uploads through the offline path of SalesService with the checked device', async () => {
      await service.push('t1', user, {
        deviceId: DEVICE,
        operations: [op('a', 1)],
      });
      expect((create.mock.calls as unknown[][])[0][4]).toMatchObject({
        offline: { deviceId: DEVICE },
      });
    });

    it('refuses a payload naming another device than the batch', async () => {
      const other = '99999999-1111-4111-8111-111111111111';
      const [ack] = (
        await service.push('t1', user, {
          deviceId: other,
          operations: [op('a', 1)],
        })
      ).results;
      expect(ack).toMatchObject({
        status: 'needs_review',
        reason: 'device_mismatch',
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses a capture time in the future', async () => {
      const payload = salePayload('a', {
        offlineCapturedAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
      const [ack] = (
        await service.push('t1', user, {
          operations: [op('a', 1, {}, payload)],
        })
      ).results;
      expect(ack).toMatchObject({
        status: 'needs_review',
        reason: 'captured_in_future',
      });
      expect(create).not.toHaveBeenCalled();
    });

    it('refuses a capture time before its lease was issued', async () => {
      // The lease was issued an hour ago
      const payload = salePayload('a', {
        offlineCapturedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
      });
      const [ack] = (
        await service.push('t1', user, {
          operations: [op('a', 1, {}, payload)],
        })
      ).results;
      expect(ack).toMatchObject({
        status: 'needs_review',
        reason: 'captured_before_lease',
      });
    });
  });
});
