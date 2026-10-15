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

// One signed-in device per user: another device's session still counts as in use when
// it was seen this recently (an open POS page calls the server every few minutes, and
// lastSeenAt is written at most every SESSION_TOUCH_INTERVAL_MS)
export const SESSION_IN_USE_MS = 15 * 60_000;

export interface SignInSession {
  id: string;
  deviceId: string | null;
  lastSeenAt: Date;
}

/**
 * A new sign-in against the user's active sessions: those in use on another device
 * stop it; the rest (same registered till, or left unused) are replaced by it.
 */
export function sessionsForSignIn<T extends SignInSession>(
  active: T[],
  deviceId: string | null,
  now: Date = new Date(),
): { blocking: T[]; replaced: T[] } {
  const blocking: T[] = [];
  const replaced: T[] = [];
  for (const session of active) {
    const sameDevice = !!deviceId && session.deviceId === deviceId;
    const idle =
      now.getTime() - session.lastSeenAt.getTime() >= SESSION_IN_USE_MS;
    (sameDevice || idle ? replaced : blocking).push(session);
  }
  return { blocking, replaced };
}
