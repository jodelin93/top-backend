/**
 * Retry schedule of outbox deliveries: exponential backoff from
 * OUTBOX_RETRY_BASE_MS (5 s) up to OUTBOX_RETRY_MAX_MS (1 h), dead-lettered
 * after OUTBOX_MAX_ATTEMPTS (10) attempts.
 */
export interface BackoffPolicy {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}

const numberFromEnv = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export function backoffPolicy(): BackoffPolicy {
  return {
    baseMs: numberFromEnv('OUTBOX_RETRY_BASE_MS', 5_000),
    maxMs: numberFromEnv('OUTBOX_RETRY_MAX_MS', 3_600_000),
    maxAttempts: Math.floor(numberFromEnv('OUTBOX_MAX_ATTEMPTS', 10)),
  };
}

/** Delay before the next attempt, after `attempts` failed ones (1, 2, ...) */
export function retryDelayMs(attempts: number, policy: BackoffPolicy): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(exponent, 30));
}

/** What to do after a failed attempt */
export function afterFailure(
  attempts: number,
  now: Date,
  policy: BackoffPolicy,
): { deadLetter: boolean; nextAttemptAt: Date } {
  if (attempts >= policy.maxAttempts) {
    return { deadLetter: true, nextAttemptAt: now };
  }
  return {
    deadLetter: false,
    nextAttemptAt: new Date(now.getTime() + retryDelayMs(attempts, policy)),
  };
}
