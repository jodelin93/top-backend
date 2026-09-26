import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isStrictEnv } from '../config/environment';

/**
 * Signed offline capability lease (spec §19, unit tested in offline-lease.spec.ts).
 *
 * Issued online (POST /devices/:id/lease, heartbeat) and kept by the till. It binds
 * the store, branch, register, device and cashier, the permissions that matter
 * offline, the store's offline limits and the validity window. The till refuses
 * offline sales outside it; the server checks every offline sale against it when
 * syncing. A sale outside the lease is still recorded (the goods left the store)
 * but opens an `offline_lease` review case.
 *
 * Format: base64url(JSON claims) + "." + base64url(HMAC-SHA256(claims part)).
 * The till can read the claims (limits, expiry) but cannot forge them.
 */
export const LEASE_VERSION = 1;

// Permissions a cashier may use while offline (the lease carries the subset held)
export const OFFLINE_LEASE_PERMISSIONS = [
  'pos.sell',
  'pos.discount',
  'pos.hold',
] as const;

// Clock drift allowed between the till and the server
export const CLOCK_TOLERANCE_MS = 5 * 60_000;

export interface OfflineLeaseLimits {
  // Largest single offline sale (0 = no limit)
  maxSaleAmount: number;
  // Offline sales allowed under one lease (0 = no limit)
  maxSales: number;
  // Total value of offline sales under one lease (0 = no limit)
  maxTotal: number;
}

export interface OfflineLeaseClaims {
  v: typeof LEASE_VERSION;
  // Lease id: offline sales are counted per lease
  jti: string;
  tid: string;
  bid: string | null;
  rid: string | null;
  did: string;
  uid: string;
  perms: string[];
  lim: OfflineLeaseLimits;
  // Issued at / expires at (epoch ms, server clock)
  iat: number;
  exp: number;
}

export type LeaseVerification =
  | { ok: true; claims: OfflineLeaseClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' };

const b64 = (value: Buffer | string) =>
  Buffer.from(value).toString('base64url');

const mac = (payload: string, secret: string) =>
  createHmac('sha256', secret).update(payload).digest();

export function issueLeaseClaims(input: {
  tenantId: string;
  branchId: string | null;
  registerId: string | null;
  deviceId: string;
  userId: string;
  permissions: readonly string[];
  limits: OfflineLeaseLimits;
  issuedAt: Date;
  expiresAt: Date;
}): OfflineLeaseClaims {
  return {
    v: LEASE_VERSION,
    jti: randomUUID(),
    tid: input.tenantId,
    bid: input.branchId,
    rid: input.registerId,
    did: input.deviceId,
    uid: input.userId,
    perms: OFFLINE_LEASE_PERMISSIONS.filter((p) =>
      input.permissions.includes(p),
    ),
    lim: input.limits,
    iat: input.issuedAt.getTime(),
    exp: input.expiresAt.getTime(),
  };
}

export function signLease(claims: OfflineLeaseClaims, secret: string): string {
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${b64(mac(payload, secret))}`;
}

/** Claims without checking the signature (for display only). */
export function decodeLease(
  token: string | null | undefined,
): OfflineLeaseClaims | null {
  if (!token || typeof token !== 'string') return null;
  const [payload] = token.split('.');
  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as OfflineLeaseClaims;
    if (
      claims?.v !== LEASE_VERSION ||
      typeof claims.jti !== 'string' ||
      typeof claims.tid !== 'string' ||
      typeof claims.did !== 'string' ||
      typeof claims.uid !== 'string' ||
      !Array.isArray(claims.perms) ||
      typeof claims.iat !== 'number' ||
      typeof claims.exp !== 'number' ||
      !claims.lim
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}

export function verifyLease(
  token: string | null | undefined,
  secret: string,
): LeaseVerification {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  const parts = token.split('.');
  const claims = parts.length === 2 ? decodeLease(token) : null;
  if (!claims) return { ok: false, reason: 'malformed' };
  const expected = mac(parts[0], secret);
  let given: Buffer;
  try {
    given = Buffer.from(parts[1], 'base64url');
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, claims };
}

/** Why an offline sale falls outside its lease (empty: within it). */
export type LeaseIssue =
  | 'lease_missing'
  | 'lease_invalid'
  | 'lease_wrong_tenant'
  | 'lease_wrong_device'
  | 'lease_wrong_branch'
  | 'lease_wrong_user'
  | 'captured_before_lease'
  | 'captured_after_lease'
  | 'captured_in_future'
  | 'over_sale_amount'
  | 'over_sales_count'
  | 'over_total'
  | 'permission_not_in_lease';

export interface OfflineSaleCheck {
  lease: LeaseVerification | null;
  tenantId: string;
  deviceId: string | null;
  branchId: string | null;
  // Cashier who rang the sale up (as reported by the till)
  actorId: string | null;
  capturedAt: Date;
  // When the server received it
  syncedAt: Date;
  saleTotal: number;
  // The sale gave a discount (needs pos.discount in the lease)
  discounted: boolean;
  // Offline sales already recorded under the same lease, before this one
  priorCount: number;
  priorTotal: number;
}

export function assessOfflineSale(check: OfflineSaleCheck): LeaseIssue[] {
  const issues: LeaseIssue[] = [];
  const captured = check.capturedAt.getTime();
  // Clock rollback / fast clock: flagged even without a lease
  if (captured > check.syncedAt.getTime() + CLOCK_TOLERANCE_MS) {
    issues.push('captured_in_future');
  }
  if (!check.lease) return ['lease_missing', ...issues];
  if (!check.lease.ok) return ['lease_invalid', ...issues];
  const { claims } = check.lease;
  if (claims.tid !== check.tenantId) issues.push('lease_wrong_tenant');
  if (check.deviceId && claims.did !== check.deviceId) {
    issues.push('lease_wrong_device');
  }
  if (claims.bid && check.branchId && claims.bid !== check.branchId) {
    issues.push('lease_wrong_branch');
  }
  if (check.actorId && claims.uid !== check.actorId) {
    issues.push('lease_wrong_user');
  }
  if (captured < claims.iat - CLOCK_TOLERANCE_MS) {
    issues.push('captured_before_lease');
  }
  if (captured > claims.exp) issues.push('captured_after_lease');
  const lim = claims.lim;
  if (lim.maxSaleAmount > 0 && check.saleTotal > lim.maxSaleAmount) {
    issues.push('over_sale_amount');
  }
  if (lim.maxSales > 0 && check.priorCount + 1 > lim.maxSales) {
    issues.push('over_sales_count');
  }
  if (
    lim.maxTotal > 0 &&
    round2(check.priorTotal + check.saleTotal) > lim.maxTotal
  ) {
    issues.push('over_total');
  }
  if (!claims.perms.includes('pos.sell'))
    issues.push('permission_not_in_lease');
  else if (check.discounted && !claims.perms.includes('pos.discount')) {
    issues.push('permission_not_in_lease');
  }
  return issues;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// ---- Secret ----

const MIN_SECRET_LENGTH = 32;
let warned = false;

/**
 * Secret the leases are signed with (OFFLINE_LEASE_SECRET). Required in
 * strict environments (production, staging, ...; see config/environment.ts);
 * in development/test a secret derived from JWT_SECRET (or a dev constant) is
 * used with a warning.
 */
export function getOfflineLeaseSecret(config: ConfigService): string {
  const secret = config.get<string>('OFFLINE_LEASE_SECRET')?.trim();
  if (secret && secret.length >= MIN_SECRET_LENGTH) return secret;
  const nodeEnv = config.get<string>('NODE_ENV');
  if (isStrictEnv(nodeEnv)) {
    throw new Error(
      `OFFLINE_LEASE_SECRET must be set (at least ${MIN_SECRET_LENGTH} characters) in ${nodeEnv}`,
    );
  }
  if (!warned) {
    warned = true;
    new Logger('Config').warn(
      'OFFLINE_LEASE_SECRET is not set; offline leases use a development secret.',
    );
  }
  const base = config.get<string>('JWT_SECRET') ?? 'dev-only-offline-lease';
  return createHash('sha256').update(`offline-lease:${base}`).digest('hex');
}
