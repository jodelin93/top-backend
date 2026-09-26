import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signed, expiring, read-only receipt links (spec §15), shared by SMS or WhatsApp
 * from the cashier's own phone/app (no SMS gateway). The token carries the store,
 * the sale, the delivery record (so a link can be revoked) and the expiry, signed
 * with HMAC-SHA256 under a key derived from RECEIPT_LINK_SECRET or JWT_SECRET.
 */
export interface ReceiptLinkClaims {
  tenantId: string;
  saleId: string;
  deliveryId: string;
  expiresAt: Date;
}

export type VerifyResult =
  | { ok: true; claims: ReceiptLinkClaims }
  | { ok: false; reason: 'malformed' | 'signature' | 'expired' };

const b64url = (buf: Buffer) => buf.toString('base64url');

/** The link key: never the raw JWT secret, so a leaked link key signs no sessions */
export function receiptLinkKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const secret =
    env.RECEIPT_LINK_SECRET?.trim() ||
    env.JWT_SECRET?.trim() ||
    // Development only: getJwtSecret() refuses to boot production without a secret
    'development-receipt-link-secret';
  return createHmac('sha256', secret).update('receipt-links/v1').digest();
}

export function signReceiptLink(
  claims: ReceiptLinkClaims,
  key: Buffer,
): string {
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        v: 1,
        t: claims.tenantId,
        s: claims.saleId,
        d: claims.deliveryId,
        e: Math.floor(claims.expiresAt.getTime() / 1000),
      }),
    ),
  );
  const signature = b64url(createHmac('sha256', key).update(payload).digest());
  return `${payload}.${signature}`;
}

export function verifyReceiptLink(
  token: string,
  key: Buffer,
  now: Date = new Date(),
): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1] || token.length > 1000) {
    return { ok: false, reason: 'malformed' };
  }
  const [payload, signature] = parts;
  const expected = createHmac('sha256', key).update(payload).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'signature' };
  }
  let data: { v?: number; t?: string; s?: string; d?: string; e?: number };
  try {
    data = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as typeof data;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (data.v !== 1 || !data.t || !data.s || !data.d || !data.e) {
    return { ok: false, reason: 'malformed' };
  }
  const expiresAt = new Date(data.e * 1000);
  if (expiresAt.getTime() <= now.getTime()) {
    return { ok: false, reason: 'expired' };
  }
  return {
    ok: true,
    claims: {
      tenantId: data.t,
      saleId: data.s,
      deliveryId: data.d,
      expiresAt,
    },
  };
}
