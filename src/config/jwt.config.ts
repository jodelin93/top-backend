import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isStrictEnv } from './environment';

const MIN_SECRET_LENGTH = 32;
const DEV_FALLBACK_SECRET = 'dev-only-insecure-jwt-secret-do-not-use-in-prod';

// Placeholder values shipped in docs/examples - never acceptable in production
const KNOWN_WEAK_SECRETS = new Set([
  'fallback-secret',
  'secret',
  'changeme',
  'change-me',
  'your-super-secret-jwt-key-change-in-production',
  DEV_FALLBACK_SECRET,
]);

let warned = false;

/**
 * Single source of truth for the JWT signing secret.
 *
 * - strict environments (production, staging, anything but development/test):
 *   throws (the app refuses to start) when JWT_SECRET is missing, shorter than
 *   32 characters, or a known placeholder.
 * - development / test: logs a warning and falls back to a dev-only secret.
 */
export function getJwtSecret(configService: ConfigService): string {
  const secret = configService.get<string>('JWT_SECRET')?.trim();
  const problem = !secret
    ? 'JWT_SECRET is not set'
    : KNOWN_WEAK_SECRETS.has(secret)
      ? 'JWT_SECRET is a known placeholder value'
      : secret.length < MIN_SECRET_LENGTH
        ? `JWT_SECRET is shorter than ${MIN_SECRET_LENGTH} characters`
        : null;

  if (!problem) {
    return secret!;
  }

  const nodeEnv = configService.get<string>('NODE_ENV');
  if (isStrictEnv(nodeEnv)) {
    throw new Error(
      `${problem}. Refusing to start in ${nodeEnv}. ` +
        'Generate one with: openssl rand -base64 48',
    );
  }

  if (!warned) {
    warned = true;
    new Logger('Config').warn(
      `${problem}; using an insecure development secret. Never deploy like this.`,
    );
  }
  return secret || DEV_FALLBACK_SECRET;
}
