import { Logger } from '@nestjs/common';
import { createHash, createHmac, randomInt } from 'crypto';
import { isStrictEnv } from '../config/environment';

/**
 * Gift card codes: 16 characters from an alphabet without look-alikes
 * (no 0/O, 1/I/L), printed in groups of four: 7KQ4-M2XH-9RTW-C3NP.
 * ~79 bits of randomness, so a code can't be guessed; only a keyed hash (HMAC,
 * see hmacGiftCardCode) and the last four characters, for display, are stored.
 */
export const GIFT_CARD_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const GIFT_CARD_CODE_LENGTH = 16;

export function generateGiftCardCode(): string {
  let code = '';
  for (let i = 0; i < GIFT_CARD_CODE_LENGTH; i++) {
    code += GIFT_CARD_ALPHABET[randomInt(GIFT_CARD_ALPHABET.length)];
  }
  return formatGiftCardCode(code);
}

/** Upper case, without spaces or dashes (what is hashed) */
export const normalizeGiftCardCode = (code: string) =>
  code.toUpperCase().replace(/[^A-Z0-9]/g, '');

export const formatGiftCardCode = (code: string) =>
  normalizeGiftCardCode(code).replace(/(.{4})(?=.)/g, '$1-');

/** Shortest pre-printed code accepted (generated codes have 16 characters) */
export const MIN_PREPRINTED_CODE_LENGTH = 12;

/**
 * Pre-printed cards may carry their own code: 12 to 32 characters, with at
 * least one letter and one digit (a short or digits-only code is too easy to
 * guess, even through the rate-limited lookup).
 */
export const isValidGiftCardCode = (code: string) => {
  const raw = normalizeGiftCardCode(code);
  return (
    new RegExp(`^[A-Z0-9]{${MIN_PREPRINTED_CODE_LENGTH},32}$`).test(raw) &&
    /[A-Z]/.test(raw) &&
    /[0-9]/.test(raw)
  );
};

export const INVALID_GIFT_CARD_CODE_MESSAGE = `A gift card code has ${MIN_PREPRINTED_CODE_LENGTH} to 32 characters, with letters and digits`;

/**
 * What is stored to find a card: HMAC-SHA256, keyed with a server secret
 * (GIFT_CARD_CODE_SECRET), of the store id and the normalised code. A copy of
 * the database alone doesn't allow guessing codes offline; the store id keeps
 * the same card from being found in another store.
 */
export const hmacGiftCardCode = (
  secret: string,
  tenantId: string,
  code: string,
) =>
  createHmac('sha256', secret)
    .update(`${tenantId}:${normalizeGiftCardCode(code)}`)
    .digest('hex');

/**
 * Legacy (before the HMAC): unkeyed sha256 of the store id and the normalised
 * code. Only used to find cards issued before, which are then upgraded to the
 * HMAC on their first use (their codes are unknown, so they can't be re-hashed
 * in bulk). Never written for new cards.
 */
export const legacyHashGiftCardCode = (tenantId: string, code: string) =>
  createHash('sha256')
    .update(`${tenantId}:${normalizeGiftCardCode(code)}`)
    .digest('hex');

const MIN_SECRET_LENGTH = 32;
let warned = false;

/** Reads settings: a ConfigService, or anything with the same get() */
export interface SecretSource {
  get<T = string>(key: string): T | undefined;
}

const envSource: SecretSource = {
  get: <T>(key: string) => process.env[key] as T | undefined,
};

/**
 * Key of the gift card code HMAC (GIFT_CARD_CODE_SECRET). Required in strict
 * environments (production, staging, ...: see config/environment.ts); in
 * development/test a key derived from JWT_SECRET (or a dev constant) is used
 * with a warning. Changing it makes every gift card unfindable: never rotate it
 * without a re-keying plan.
 */
export function getGiftCardCodeSecret(
  config: SecretSource = envSource,
): string {
  const secret = config.get<string>('GIFT_CARD_CODE_SECRET')?.trim();
  if (secret && secret.length >= MIN_SECRET_LENGTH) return secret;
  const nodeEnv = config.get<string>('NODE_ENV');
  if (isStrictEnv(nodeEnv)) {
    throw new Error(
      `GIFT_CARD_CODE_SECRET must be set (at least ${MIN_SECRET_LENGTH} characters) in ${nodeEnv}`,
    );
  }
  if (!warned) {
    warned = true;
    new Logger('Config').warn(
      'GIFT_CARD_CODE_SECRET is not set; gift card codes use a development key.',
    );
  }
  const base = config.get<string>('JWT_SECRET') ?? 'dev-only-gift-card-code';
  return createHash('sha256').update(`gift-card-code:${base}`).digest('hex');
}

export const last4Of = (code: string) => normalizeGiftCardCode(code).slice(-4);
