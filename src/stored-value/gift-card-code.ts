import { createHash, randomInt } from 'crypto';

/**
 * Gift card codes: 16 characters from an alphabet without look-alikes
 * (no 0/O, 1/I/L), printed in groups of four: 7KQ4-M2XH-9RTW-C3NP.
 * ~79 bits of randomness, so a code can't be guessed; only a hash (and the last
 * four characters, for display) is stored.
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

/** Pre-printed cards may carry their own code: 8 to 32 letters / digits */
export const isValidGiftCardCode = (code: string) =>
  /^[A-Z0-9]{8,32}$/.test(normalizeGiftCardCode(code));

/** sha256 of the store id and the normalised code: the same card can't be found in another store */
export const hashGiftCardCode = (tenantId: string, code: string) =>
  createHash('sha256')
    .update(`${tenantId}:${normalizeGiftCardCode(code)}`)
    .digest('hex');

export const last4Of = (code: string) => normalizeGiftCardCode(code).slice(-4);
