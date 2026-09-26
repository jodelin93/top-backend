import {
  assessOfflineSale,
  CLOCK_TOLERANCE_MS,
  decodeLease,
  issueLeaseClaims,
  OfflineSaleCheck,
  signLease,
  verifyLease,
} from './offline-lease';

const SECRET = 'test-offline-lease-secret-0123456789abcdef';
const issuedAt = new Date('2026-09-24T08:00:00Z');
const expiresAt = new Date('2026-09-25T08:00:00Z');

const claims = (limits = { maxSaleAmount: 0, maxSales: 0, maxTotal: 0 }) =>
  issueLeaseClaims({
    tenantId: 't1',
    branchId: 'b1',
    registerId: 'r1',
    deviceId: 'd1',
    userId: 'u1',
    permissions: ['pos.sell', 'pos.discount', 'sales.void', 'pos.hold'],
    limits,
    issuedAt,
    expiresAt,
  });

const check = (
  extra: Partial<OfflineSaleCheck> = {},
  limits?: Parameters<typeof claims>[0],
): OfflineSaleCheck => ({
  lease: verifyLease(signLease(claims(limits), SECRET), SECRET),
  tenantId: 't1',
  deviceId: 'd1',
  branchId: 'b1',
  actorId: 'u1',
  capturedAt: new Date('2026-09-24T12:00:00Z'),
  syncedAt: new Date('2026-09-24T13:00:00Z'),
  saleTotal: 50,
  discounted: false,
  priorCount: 0,
  priorTotal: 0,
  ...extra,
});

describe('offline lease signing', () => {
  it('signs and verifies, keeping only the offline permissions', () => {
    const token = signLease(claims(), SECRET);
    const result = verifyLease(token, SECRET);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.claims).toMatchObject({
      tid: 't1',
      bid: 'b1',
      did: 'd1',
      uid: 'u1',
      iat: issuedAt.getTime(),
      exp: expiresAt.getTime(),
    });
    expect(result.claims.perms).toEqual([
      'pos.sell',
      'pos.discount',
      'pos.hold',
    ]);
  });

  it('rejects a tampered lease or another secret', () => {
    const token = signLease(claims(), SECRET);
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...decodeLease(token),
        lim: { maxSaleAmount: 0, maxSales: 0, maxTotal: 0 },
        exp: Date.parse('2030-01-01T00:00:00Z'),
      }),
    ).toString('base64url');
    expect(verifyLease(`${forged}.${sig}`, SECRET)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyLease(token, `${SECRET}-other`).ok).toBe(false);
    expect(verifyLease(`${payload}`, SECRET)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(verifyLease('garbage.sig', SECRET).ok).toBe(false);
    expect(verifyLease(undefined, SECRET).ok).toBe(false);
  });

  it('gives every lease its own id', () => {
    expect(claims().jti).not.toEqual(claims().jti);
  });
});

describe('offline sale against its lease', () => {
  it('accepts a sale inside the lease and its limits', () => {
    expect(assessOfflineSale(check())).toEqual([]);
  });

  it('flags a missing or forged lease', () => {
    expect(assessOfflineSale(check({ lease: null }))).toEqual([
      'lease_missing',
    ]);
    expect(
      assessOfflineSale(
        check({ lease: { ok: false, reason: 'bad_signature' } }),
      ),
    ).toEqual(['lease_invalid']);
  });

  it('flags a sale captured after the lease expired', () => {
    expect(
      assessOfflineSale(
        check({
          capturedAt: new Date(expiresAt.getTime() + 1),
          syncedAt: new Date(expiresAt.getTime() + 3600_000),
        }),
      ),
    ).toEqual(['captured_after_lease']);
  });

  it('flags clock rollback: captured before the lease was issued', () => {
    expect(
      assessOfflineSale(
        check({
          capturedAt: new Date(issuedAt.getTime() - CLOCK_TOLERANCE_MS - 1),
        }),
      ),
    ).toEqual(['captured_before_lease']);
    // Within the tolerance: fine
    expect(
      assessOfflineSale(
        check({ capturedAt: new Date(issuedAt.getTime() - 60_000) }),
      ),
    ).toEqual([]);
  });

  it('flags a capture time ahead of the server beyond the tolerance', () => {
    const syncedAt = new Date('2026-09-24T12:00:00Z');
    expect(
      assessOfflineSale(
        check({
          syncedAt,
          capturedAt: new Date(syncedAt.getTime() + CLOCK_TOLERANCE_MS + 1000),
        }),
      ),
    ).toContain('captured_in_future');
  });

  it('flags sales over the limits', () => {
    const limits = { maxSaleAmount: 100, maxSales: 3, maxTotal: 200 };
    expect(assessOfflineSale(check({ saleTotal: 100.01 }, limits))).toEqual([
      'over_sale_amount',
    ]);
    expect(assessOfflineSale(check({ priorCount: 2 }, limits))).toEqual([]);
    expect(assessOfflineSale(check({ priorCount: 3 }, limits))).toEqual([
      'over_sales_count',
    ]);
    expect(
      assessOfflineSale(check({ priorTotal: 150.01, saleTotal: 50 }, limits)),
    ).toEqual(['over_total']);
    // 0 = no limit
    expect(
      assessOfflineSale(
        check({ saleTotal: 1e9, priorCount: 1e6, priorTotal: 1e12 }),
      ),
    ).toEqual([]);
  });

  it('flags a lease bound to another device, branch, user or store', () => {
    expect(
      assessOfflineSale(
        check({
          deviceId: 'd2',
          branchId: 'b2',
          actorId: 'u2',
          tenantId: 't2',
        }),
      ).sort(),
    ).toEqual(
      [
        'lease_wrong_branch',
        'lease_wrong_device',
        'lease_wrong_tenant',
        'lease_wrong_user',
      ].sort(),
    );
  });

  it('flags a discount when the lease lacks pos.discount', () => {
    const noDiscount = issueLeaseClaims({
      ...{
        tenantId: 't1',
        branchId: 'b1',
        registerId: 'r1',
        deviceId: 'd1',
        userId: 'u1',
        limits: { maxSaleAmount: 0, maxSales: 0, maxTotal: 0 },
        issuedAt,
        expiresAt,
      },
      permissions: ['pos.sell'],
    });
    const lease = verifyLease(signLease(noDiscount, SECRET), SECRET);
    expect(assessOfflineSale(check({ lease, discounted: true }))).toEqual([
      'permission_not_in_lease',
    ]);
    expect(assessOfflineSale(check({ lease, discounted: false }))).toEqual([]);
  });
});
