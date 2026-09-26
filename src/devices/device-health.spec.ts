import {
  assessDevice,
  DeviceHealthInput,
  findSequenceGaps,
  isLeaseValid,
  leaseExpiry,
} from './device-health';

const now = new Date('2026-09-24T12:00:00Z');
const input = (extra: Partial<DeviceHealthInput> = {}): DeviceHealthInput => ({
  lastSequence: 0,
  maxReceivedSequence: null,
  receivedCount: 0,
  pendingSales: 0,
  failedSales: 0,
  lastSeenAt: new Date(now.getTime() - 60_000),
  revokedAt: null,
  leaseExpiresAt: new Date(now.getTime() + 3600_000),
  now,
  staleAfterMs: 3600_000,
  ...extra,
});

describe('sequence gap detection', () => {
  it('lists the sequences the server never received', () => {
    expect(findSequenceGaps([1, 2, 4, 7], 8)).toEqual([3, 5, 6, 8]);
    expect(findSequenceGaps([1, 2, 3], 3)).toEqual([]);
    expect(findSequenceGaps([], 500, 3)).toEqual([1, 2, 3]);
  });

  it('is healthy when every sequence has arrived', () => {
    const health = assessDevice(
      input({ lastSequence: 5, maxReceivedSequence: 5, receivedCount: 5 }),
    );
    expect(health).toMatchObject({
      status: 'ok',
      missingCount: 0,
      unaccountedCount: 0,
    });
  });

  it('does not flag sales the device still reports as queued', () => {
    const health = assessDevice(
      input({
        lastSequence: 7,
        maxReceivedSequence: 5,
        receivedCount: 5,
        pendingSales: 2,
      }),
    );
    expect(health).toMatchObject({
      status: 'pending',
      missingCount: 2,
      unaccountedCount: 0,
    });
  });

  it('flags a gap: a sequence missing on the server that the device no longer holds', () => {
    // Device handed out 1..6, server has 1,2,4,5,6, device queue is empty → #3 is lost
    const health = assessDevice(
      input({ lastSequence: 6, maxReceivedSequence: 6, receivedCount: 5 }),
    );
    expect(health).toMatchObject({
      status: 'gap',
      missingCount: 1,
      unaccountedCount: 1,
    });
  });

  it('uses the highest received sequence when the device under-reports', () => {
    const health = assessDevice(
      input({ lastSequence: 2, maxReceivedSequence: 9, receivedCount: 8 }),
    );
    expect(health.expectedSequence).toBe(9);
    expect(health.status).toBe('gap');
  });

  it('flags a silent device still holding sales', () => {
    const health = assessDevice(
      input({
        pendingSales: 3,
        lastSequence: 3,
        lastSeenAt: new Date(now.getTime() - 5 * 3600_000),
      }),
    );
    expect(health).toMatchObject({ status: 'stale_pending', stale: true });
  });

  it('reports revoked devices first', () => {
    expect(assessDevice(input({ revokedAt: now })).status).toBe('revoked');
  });
});

describe('offline lease', () => {
  it('runs offlineLeaseHours from now', () => {
    expect(leaseExpiry(now, 12).toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(leaseExpiry(now, NaN).getTime() - now.getTime()).toBe(24 * 3600_000);
  });

  it('expires at leaseExpiresAt and never holds for a revoked device', () => {
    const leaseExpiresAt = new Date(now.getTime() + 1000);
    expect(isLeaseValid({ leaseExpiresAt, revokedAt: null }, now)).toBe(true);
    expect(
      isLeaseValid(
        { leaseExpiresAt, revokedAt: null },
        new Date(now.getTime() + 1000),
      ),
    ).toBe(false);
    expect(isLeaseValid({ leaseExpiresAt: null, revokedAt: null }, now)).toBe(
      false,
    );
    expect(isLeaseValid({ leaseExpiresAt, revokedAt: now }, now)).toBe(false);
    expect(assessDevice(input({ leaseExpiresAt: now })).leaseActive).toBe(
      false,
    );
  });
});
