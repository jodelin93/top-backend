import { createHash } from 'crypto';

/**
 * Canonical JSON: object keys sorted, `undefined` members dropped, arrays kept in
 * order. The till (src/lib/pos/payload-hash.ts in the frontend) computes the same
 * string, so both sides agree on the sha256 of an operation's payload.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((v) => (v === undefined ? 'null' : canonicalJson(v)))
      .join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`)
    .join(',')}}`;
}

export const payloadHash = (payload: unknown) =>
  createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
