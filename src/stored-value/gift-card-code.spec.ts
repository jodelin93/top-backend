import {
  formatGiftCardCode,
  generateGiftCardCode,
  GIFT_CARD_ALPHABET,
  getGiftCardCodeSecret,
  hmacGiftCardCode,
  isValidGiftCardCode,
  legacyHashGiftCardCode,
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

  it('are stored as a keyed hash only, the same however they are typed', () => {
    const code = 'ABCD-EFGH-2345-6789';
    const secret = 'k'.repeat(40);
    const hash = hmacGiftCardCode(secret, 'tenant-1', code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(normalizeGiftCardCode(code));
    expect(hmacGiftCardCode(secret, 'tenant-1', 'abcd efgh 2345 6789')).toBe(
      hash,
    );
    // Another store can't find the same card
    expect(hmacGiftCardCode(secret, 'tenant-2', code)).not.toBe(hash);
    // Without the key, the database alone doesn't give the code away
    expect(hmacGiftCardCode('x'.repeat(40), 'tenant-1', code)).not.toBe(hash);
    expect(legacyHashGiftCardCode('tenant-1', code)).not.toBe(hash);
  });

  it('keep the legacy unkeyed hash for finding older cards', () => {
    const code = 'ABCD-EFGH-2345-6789';
    const legacy = legacyHashGiftCardCode('tenant-1', code);
    expect(legacy).toMatch(/^[0-9a-f]{64}$/);
    expect(legacyHashGiftCardCode('tenant-1', 'abcdefgh23456789')).toBe(legacy);
  });

  it('keep the last four for display', () => {
    expect(last4Of('ABCD-EFGH-2345-6789')).toBe('6789');
    expect(formatGiftCardCode('abcdefgh23456789')).toBe('ABCD-EFGH-2345-6789');
  });

  it('accept pre-printed codes of 12+ characters with letters and digits', () => {
    expect(isValidGiftCardCode('ABCD-1234-EF56')).toBe(true);
    expect(isValidGiftCardCode(generateGiftCardCode())).toBe(true);
    // Too short (was accepted before), digits only, letters only, too long
    expect(isValidGiftCardCode('1234-5678')).toBe(false);
    expect(isValidGiftCardCode('ABC-12345-67')).toBe(false);
    expect(isValidGiftCardCode('1234-5678-9012-3456')).toBe(false);
    expect(isValidGiftCardCode('ABCD-EFGH-JKMN-PQRS')).toBe(false);
    expect(isValidGiftCardCode('A1'.repeat(17))).toBe(false);
    expect(isValidGiftCardCode('12-34')).toBe(false);
  });
});

describe('getGiftCardCodeSecret', () => {
  const source = (values: Record<string, string | undefined>) => ({
    get: <T>(key: string) => values[key] as T | undefined,
  });

  it('uses GIFT_CARD_CODE_SECRET when set', () => {
    const secret = 's'.repeat(48);
    expect(
      getGiftCardCodeSecret(
        source({ GIFT_CARD_CODE_SECRET: secret, NODE_ENV: 'production' }),
      ),
    ).toBe(secret);
  });

  it('is required in strict environments', () => {
    for (const NODE_ENV of ['production', 'staging']) {
      expect(() =>
        getGiftCardCodeSecret(source({ NODE_ENV, JWT_SECRET: 'j'.repeat(48) })),
      ).toThrow(/GIFT_CARD_CODE_SECRET/);
      expect(() =>
        getGiftCardCodeSecret(
          source({ NODE_ENV, GIFT_CARD_CODE_SECRET: 'too-short' }),
        ),
      ).toThrow(/GIFT_CARD_CODE_SECRET/);
    }
  });

  it('derives a stable development key from JWT_SECRET', () => {
    const dev = source({ NODE_ENV: 'development', JWT_SECRET: 'j'.repeat(48) });
    const key = getGiftCardCodeSecret(dev);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe('j'.repeat(48));
    expect(getGiftCardCodeSecret(dev)).toBe(key);
    expect(
      getGiftCardCodeSecret(
        source({ NODE_ENV: 'test', JWT_SECRET: 'other'.repeat(10) }),
      ),
    ).not.toBe(key);
  });
});
