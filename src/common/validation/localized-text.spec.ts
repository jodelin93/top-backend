import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  IsBoundedMetadata,
  IsLocalizedText,
  isBoundedMetadata,
  isLocalizedText,
} from './localized-text';

class Dto {
  @IsLocalizedText({ maxLength: 10, requireOne: true }) name: unknown;
  @IsBoundedMetadata() metadata: unknown;
}

describe('localized text', () => {
  it('accepts supported locales with bounded string values', () => {
    expect(isLocalizedText({ en: 'Mug', fr: 'Tasse' }, 255)).toBe(true);
    expect(isLocalizedText({}, 255)).toBe(true);
    expect(isLocalizedText({}, 255, true)).toBe(false);
    expect(isLocalizedText({ en: '  ' }, 255, true)).toBe(false);
  });

  it('rejects unknown keys, non-strings, long text and non-objects', () => {
    expect(isLocalizedText({ de: 'Becher' }, 255)).toBe(false);
    expect(isLocalizedText({ en: { nested: 'x' } }, 255)).toBe(false);
    expect(isLocalizedText({ en: 'x'.repeat(256) }, 255)).toBe(false);
    expect(isLocalizedText(['en'], 255)).toBe(false);
    expect(isLocalizedText('Mug', 255)).toBe(false);
  });
});

describe('bounded metadata', () => {
  it('limits size and depth', () => {
    expect(isBoundedMetadata({ unit: 'kg', tags: ['a'] })).toBe(true);
    expect(isBoundedMetadata({ a: { b: { c: 1 } } })).toBe(true);
    expect(isBoundedMetadata({ a: { b: { c: { d: 1 } } } })).toBe(false);
    expect(isBoundedMetadata({ big: 'x'.repeat(5000) })).toBe(false);
    expect(isBoundedMetadata([1])).toBe(false);
  });

  it('works as class-validator decorators', () => {
    const ok = plainToInstance(Dto, { name: { en: 'Mug' }, metadata: {} });
    expect(validateSync(ok)).toHaveLength(0);
    const bad = plainToInstance(Dto, {
      name: { xx: 'Mug' },
      metadata: { a: { b: { c: { d: 1 } } } },
    });
    expect(validateSync(bad).map((e) => e.property)).toEqual([
      'name',
      'metadata',
    ]);
  });
});
