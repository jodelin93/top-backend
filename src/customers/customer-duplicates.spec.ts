import {
  normalizeEmail,
  normalizeName,
  normalizePhone,
} from './customer-duplicates.service';

describe('duplicate detection normalisation', () => {
  it('compares emails case- and space-insensitively', () => {
    expect(normalizeEmail('  Ann@Example.COM ')).toBe('ann@example.com');
    expect(normalizeEmail('  ')).toBeNull();
  });

  it('compares phones on their last 9 digits, ignoring formatting and country codes', () => {
    expect(normalizePhone('+1 (555) 222-3333')).toBe(
      normalizePhone('555.222.3333'),
    );
    expect(normalizePhone('+33 6 12 34 56 78')).toBe(
      normalizePhone('06 12 34 56 78'),
    );
    expect(normalizePhone('12-34')).toBeNull();
  });

  it('needs a name of at least 3 characters', () => {
    expect(normalizeName('Ann', 'LEE')).toBe('ann lee');
    expect(normalizeName('Al', null)).toBeNull();
  });
});
