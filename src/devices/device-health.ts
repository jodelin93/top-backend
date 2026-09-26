/**
 * Pure rules for device sync health (unit tested in device-health.spec.ts).
 *
 * Every offline sale gets a per-device, monotonically increasing deviceSequence
 * (1, 2, 3...). The server knows which sequences it has received, and the device
 * reports the highest one it handed out plus how many sales are still queued.
 * A sequence that is neither on the server nor reported as queued is a gap: a sale
 * stuck on (or lost from) the device.
 */
export type DeviceStatus =
  'revoked' | 'gap' | 'stale_pending' | 'failed' | 'pending' | 'stale' | 'ok';

export interface DeviceHealthInput {
  lastSequence: number;
  maxReceivedSequence: number | null;
  receivedCount: number;
  pendingSales: number;
  failedSales: number;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  leaseExpiresAt: Date | null;
  now: Date;
  staleAfterMs: number;
}

export interface DeviceHealth {
  status: DeviceStatus;
  expectedSequence: number;
  // Sequences not received by the server (includes those still queued on the device)
  missingCount: number;
  // Missing sequences the device does not report as queued: stuck or lost sales
  unaccountedCount: number;
  stale: boolean;
  leaseActive: boolean;
}

export function assessDevice(input: DeviceHealthInput): DeviceHealth {
  const expectedSequence = Math.max(
    input.lastSequence,
    input.maxReceivedSequence ?? 0,
  );
  const missingCount = Math.max(0, expectedSequence - input.receivedCount);
  const unaccountedCount = Math.max(0, missingCount - input.pendingSales);
  const stale =
    !input.lastSeenAt ||
    input.now.getTime() - input.lastSeenAt.getTime() > input.staleAfterMs;
  const leaseActive =
    !input.revokedAt &&
    !!input.leaseExpiresAt &&
    input.leaseExpiresAt.getTime() > input.now.getTime();

  const status: DeviceStatus = input.revokedAt
    ? 'revoked'
    : unaccountedCount > 0
      ? 'gap'
      : input.pendingSales > 0 && stale
        ? 'stale_pending'
        : input.failedSales > 0
          ? 'failed'
          : input.pendingSales > 0
            ? 'pending'
            : stale
              ? 'stale'
              : 'ok';

  return {
    status,
    expectedSequence,
    missingCount,
    unaccountedCount,
    stale,
    leaseActive,
  };
}

/** Sequences in 1..upTo that were not received (ascending, at most `limit`). */
export function findSequenceGaps(
  received: Iterable<number>,
  upTo: number,
  limit = 200,
): number[] {
  const seen = new Set(received);
  const missing: number[] = [];
  for (let seq = 1; seq <= upTo && missing.length < limit; seq++) {
    if (!seen.has(seq)) missing.push(seq);
  }
  return missing;
}

/** Offline lease end: now + the store's offlineLeaseHours. */
export function leaseExpiry(now: Date, offlineLeaseHours: number): Date {
  const hours =
    Number.isFinite(offlineLeaseHours) && offlineLeaseHours > 0
      ? offlineLeaseHours
      : 24;
  return new Date(now.getTime() + hours * 3600_000);
}

export function isLeaseValid(
  lease: { leaseExpiresAt: Date | null; revokedAt: Date | null },
  now: Date,
): boolean {
  return (
    !lease.revokedAt &&
    !!lease.leaseExpiresAt &&
    lease.leaseExpiresAt.getTime() > now.getTime()
  );
}
