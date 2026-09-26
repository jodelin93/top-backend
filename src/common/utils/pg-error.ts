import { QueryFailedError } from 'typeorm';

// Postgres SQLSTATE codes we react to
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';

interface PgDriverError {
  code?: unknown;
  constraint?: unknown;
}

/**
 * True when `error` is a TypeORM QueryFailedError raised by Postgres with the
 * given SQLSTATE code (and, if provided, on the given constraint name).
 */
export function isPgError(
  error: unknown,
  code: string,
  constraint?: string,
): error is QueryFailedError {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError = error.driverError as PgDriverError | undefined;
  if (driverError?.code !== code) return false;
  return constraint === undefined || driverError.constraint === constraint;
}
