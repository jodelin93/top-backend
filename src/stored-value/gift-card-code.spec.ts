import {
  formatGiftCardCode,
  generateGiftCardCode,
  GIFT_CARD_ALPHABET,
  hashGiftCardCode,
  isValidGiftCardCode,
  last4Of,
  normalizeGiftCardCode,
} from './gift-card-code';

describe('gift card codes', () => {
  it('are 16 characters without look-alikes, in groups of four', () => {
    const code = generateGiftCardCode();
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    const raw = normalizeGiftCardCode(code);
    expect(raw).toHaveLength(16);
    expect([...raw].every((c) => GIFT_CARD_ALPHABET.includes(c))).toBe(true);
    expect(raw).not.toMatch(/[01OIL]/);
  });

  it('are random', () => {
    const codes = new Set(Array.from({ length: 200 }, generateGiftCardCode));
    expect(codes.size).toBe(200);
  });

  it('are stored as a hash only, the same however they are typed', () => {
    const code = 'ABCD-EFGH-2345-6789';
    const hash = hashGiftCardCode('tenant-1', code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(normalizeGiftCardCode(code));
    expect(hashGiftCardCode('tenant-1', 'abcd efgh 2345 6789')).toBe(hash);
    // Another store can't find the same card
    expect(hashGiftCardCode('tenant-2', code)).not.toBe(hash);
  });

  it('keep the last four for display, and accept pre-printed codes', () => {
    expect(last4Of('ABCD-EFGH-2345-6789')).toBe('6789');
    expect(formatGiftCardCode('abcdefgh23456789')).toBe('ABCD-EFGH-2345-6789');
    expect(isValidGiftCardCode('1234-5678')).toBe(true);
    expect(isValidGiftCardCode('12-34')).toBe(false);
  });
});
