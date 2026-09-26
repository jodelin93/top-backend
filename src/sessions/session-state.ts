/**
 * Pure session rules (unit tested in sessions.service.spec.ts).
 */
export type SessionStatus = 'active' | 'revoked' | 'expired';

// lastSeenAt is written at most this often per session, to keep request overhead low
export const SESSION_TOUCH_INTERVAL_MS = 5 * 60_000;

export function sessionStatus(
  session: { revokedAt: Date | null; expiresAt: Date },
  now: Date = new Date(),
): SessionStatus {
  if (session.revokedAt) return 'revoked';
  if (session.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

export function shouldTouch(lastSeenAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS;
}
