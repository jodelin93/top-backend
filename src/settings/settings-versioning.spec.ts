import {
  diffSettings,
  dueVersions,
  nextScheduledAt,
  resolveEffective,
  VersionLike,
  versionStatus,
} from './settings-versioning';

const at = (iso: string) => new Date(iso);
const version = (
  n: number,
  effectiveFrom: string,
  changes: Record<string, unknown>,
  extra: Partial<VersionLike> = {},
): VersionLike => ({
  version: n,
  effectiveFrom: at(effectiveFrom),
  changes,
  appliedAt: null,
  cancelledAt: null,
  ...extra,
});

describe('settings versioning', () => {
  const applied = {
    maxDiscountPercent: 20,
    receiptFooter: 'Thanks',
    storeName: 'Shop',
  };

  it('diffs only the values that change', () => {
    expect(
      diffSettings(applied, {
        maxDiscountPercent: 20,
        receiptFooter: 'Merci',
        storeName: undefined,
      }),
    ).toEqual({
      changes: { receiptFooter: 'Merci' },
      changedKeys: ['receiptFooter'],
    });
  });

  it('treats equal objects and null/undefined as unchanged', () => {
    expect(
      diffSettings({ a: null, b: { x: 1 } }, { a: null, b: { x: 1 } })
        .changedKeys,
    ).toEqual([]);
  });

  it('ignores scheduled changes before their effective date', () => {
    const versions = [
      version(2, '2026-10-01T00:00:00Z', { maxDiscountPercent: 30 }),
    ];
    expect(
      resolveEffective(applied, versions, at('2026-09-30T23:59:59Z')),
    ).toEqual(applied);
    expect(
      resolveEffective(applied, versions, at('2026-10-01T00:00:00Z'))
        .maxDiscountPercent,
    ).toBe(30);
  });

  it('applies due changes in effective-date order, later ones winning per key', () => {
    const versions = [
      version(3, '2026-10-02T00:00:00Z', { maxDiscountPercent: 40 }),
      version(2, '2026-10-01T00:00:00Z', {
        maxDiscountPercent: 30,
        receiptFooter: 'Autumn sale',
      }),
    ];
    expect(
      resolveEffective(applied, versions, at('2026-10-03T00:00:00Z')),
    ).toEqual({
      maxDiscountPercent: 40,
      receiptFooter: 'Autumn sale',
      storeName: 'Shop',
    });
    expect(
      dueVersions(versions, at('2026-10-03T00:00:00Z')).map((v) => v.version),
    ).toEqual([2, 3]);
  });

  it('skips cancelled and already applied versions', () => {
    const versions = [
      version(
        2,
        '2026-10-01T00:00:00Z',
        { maxDiscountPercent: 30 },
        {
          cancelledAt: at('2026-09-25T00:00:00Z'),
        },
      ),
      version(
        3,
        '2026-09-20T00:00:00Z',
        { receiptFooter: 'Old' },
        {
          appliedAt: at('2026-09-20T00:00:00Z'),
        },
      ),
    ];
    expect(
      resolveEffective(applied, versions, at('2026-12-01T00:00:00Z')),
    ).toEqual(applied);
    expect(versionStatus(versions[0])).toBe('cancelled');
    expect(versionStatus(versions[1])).toBe('applied');
    expect(versionStatus(version(4, '2026-12-01T00:00:00Z', {}))).toBe(
      'scheduled',
    );
  });

  it('knows when the next scheduled change is due (cache expiry)', () => {
    const versions = [
      version(2, '2026-10-05T00:00:00Z', {}),
      version(3, '2026-10-01T00:00:00Z', {}),
      version(4, '2026-09-01T00:00:00Z', {}),
    ];
    expect(nextScheduledAt(versions, at('2026-09-24T00:00:00Z'))).toEqual(
      at('2026-10-01T00:00:00Z'),
    );
    expect(nextScheduledAt([], at('2026-09-24T00:00:00Z'))).toBeNull();
  });
});
