/**
 * Credential checks shared by sign-in, two-factor, store signup and manager
 * approvals (security review):
 * - per-account lockout: MAX_FAILED_ATTEMPTS wrong passwords or codes in a row
 *   lock the account for LOCK_MINUTES (again after each further failure until a
 *   successful sign-in), whatever IP address the guesses come from;
 * - unknown accounts cost a bcrypt compare too, so response time doesn't reveal
 *   which emails exist;
 * - two-factor codes are accepted once (the time step used is stored) within
 *   ±1 step (30 s) of the server clock.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import * as speakeasy from 'speakeasy';
import type { User } from '../database/entities/user.entity';

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
const TOTP_STEP_SECONDS = 30;

// Hash of a random value, compared against when the account doesn't exist
let dummyHash: string | null = null;
const getDummyHash = () =>
  (dummyHash ??= bcrypt.hashSync(
    `no-such-account-${Math.random()}`,
    bcrypt.genSaltSync(10),
  ));

/** Anything that runs SQL: a repository, an entity manager, a data source */
export interface SqlRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export class AccountLockedException extends HttpException {
  constructor() {
    super(
      'Too many failed attempts. This account is locked for a few minutes.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export const isLocked = (
  user: Pick<User, 'lockedUntil'>,
  now = new Date(),
): boolean =>
  !!user.lockedUntil && new Date(user.lockedUntil).getTime() > now.getTime();

export function assertNotLocked(
  user: Pick<User, 'lockedUntil'> | null | undefined,
): void {
  if (user && isLocked(user)) throw new AccountLockedException();
}

/** Password check that takes as long for an unknown account as for a known one */
export async function passwordMatches(
  user: Pick<User, 'passwordHash'> | null | undefined,
  password: string,
): Promise<boolean> {
  const ok = await bcrypt.compare(
    password,
    user?.passwordHash || getDummyHash(),
  );
  return !!user?.passwordHash && ok;
}

/** One more wrong password or code; locks the account at the limit */
export async function recordFailedAttempt(
  db: SqlRunner,
  userId: string,
): Promise<void> {
  await db.query(
    `UPDATE users SET
       "failedLoginCount" = "failedLoginCount" + 1,
       "lockedUntil" = CASE WHEN "failedLoginCount" + 1 >= $2
         THEN NOW() + make_interval(mins => $3) ELSE "lockedUntil" END
     WHERE id = $1`,
    [userId, MAX_FAILED_ATTEMPTS, LOCK_MINUTES],
  );
}

/** A complete, successful sign-in clears the counter */
export async function clearFailedAttempts(
  db: SqlRunner,
  userId: string,
): Promise<void> {
  await db.query(
    `UPDATE users SET "failedLoginCount" = 0, "lockedUntil" = NULL
     WHERE id = $1 AND ("failedLoginCount" <> 0 OR "lockedUntil" IS NOT NULL)`,
    [userId],
  );
}

/** Time step a code matches (±1 step), or null */
export function totpStep(
  secret: string | null | undefined,
  code: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!secret || !code || !/^\d{6}$/.test(code)) return null;
  const match = speakeasy.totp.verifyDelta({
    secret,
    encoding: 'base32',
    token: code,
    window: 1,
    time: Math.floor(now / 1000),
  });
  if (!match) return null;
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS) + match.delta;
}

/**
 * Check a two-factor code and use it up: the same code (or an older one) is
 * refused afterwards, even within its 30-second window.
 */
export async function consumeTotp(
  db: SqlRunner,
  user: Pick<User, 'id' | 'mfaSecret'>,
  code: string | null | undefined,
): Promise<boolean> {
  const step = totpStep(user.mfaSecret, code);
  if (step === null) return false;
  const result = await db.query(
    `UPDATE users SET "mfaLastUsedStep" = $2
     WHERE id = $1 AND ("mfaLastUsedStep" IS NULL OR "mfaLastUsedStep" < $2)
     RETURNING id`,
    [user.id, step],
  );
  return updatedRows(result) > 0;
}

// TypeORM's query() gives [rows, count] for UPDATE … RETURNING on Postgres
function updatedRows(result: unknown): number {
  if (!Array.isArray(result)) return 0;
  if (result.length === 2 && Array.isArray(result[0])) {
    return (result[0] as unknown[]).length;
  }
  return result.length;
}
