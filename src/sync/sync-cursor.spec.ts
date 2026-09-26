import {
  advanceCursor,
  ChangeRow,
  collectChanges,
  decodeCursor,
  encodeCursor,
  MAX_CURSOR_AGE_MS,
  resetReasonFor,
  SyncCursor,
} from './sync-cursor';

const cursor: SyncCursor = {
  v: 2,
  s: '120',
  x: '9007',
  r: 'reg-1',
  b: 'br-1',
  at: '2026-09-24T10:00:05.000000Z',
};

const row = (
  seq: number,
  entity: string,
  entityId: string,
  op: 'U' | 'D' = 'U',
  scope: string | null = null,
): ChangeRow => ({ seq: String(seq), entity, entityId, op, scope });

describe('sync cursor v2', () => {
  it('round-trips through its opaque encoding', () => {
    const encoded = encodeCursor(cursor);
    expect(encoded).not.toContain('{');
    expect(decodeCursor(encoded)).toEqual(cursor);
  });

  it('rejects malformed and v1 (updated_at) cursors', () => {
    expect(decodeCursor('not-base64-json')).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor(encodeCursor({ ...cursor, s: '12; drop' }))).toBeNull();
    const v1 = Buffer.from(
      JSON.stringify({
        v: 1,
        c: { ts: '2026-09-24T10:00:00Z', id: 'a' },
        at: '2026-09-24T10:00:00Z',
      }),
    ).toString('base64url');
    expect(decodeCursor(v1)).toBeNull();
  });

  it('asks for a full download when needed', () => {
    const ctx = {
      now: '2026-09-24T11:00:00Z',
      registerId: 'reg-1',
      branchId: 'br-1',
    };
    expect(resetReasonFor(undefined, null, ctx)).toBe('first_sync');
    expect(resetReasonFor('junk', null, ctx)).toBe('invalid_cursor');
    expect(resetReasonFor('x', cursor, ctx)).toBeNull();
    expect(resetReasonFor('x', cursor, { ...ctx, registerId: 'reg-2' })).toBe(
      'register_changed',
    );
    // The register moved to another branch: another assortment
    expect(resetReasonFor('x', cursor, { ...ctx, branchId: 'br-2' })).toBe(
      'register_changed',
    );
    expect(
      resetReasonFor('x', cursor, {
        ...ctx,
        now: new Date(
          Date.parse(cursor.at) + MAX_CURSOR_AGE_MS + 1000,
        ).toISOString(),
      }),
    ).toBe('cursor_too_old');
  });

  it('advances to the last delivered seq (never backwards) and the new xmin', () => {
    expect(
      advanceCursor(cursor, { lastSeq: '250', xmin: '9100', now: 'n' }),
    ).toMatchObject({ s: '250', x: '9100', at: 'n' });
    // Only replayed rows (below s) delivered: s stays
    expect(
      advanceCursor(cursor, { lastSeq: null, xmin: '9100', now: 'n' }),
    ).toMatchObject({ s: '120', x: '9100' });
    expect(
      advanceCursor(cursor, { lastSeq: '99', xmin: '9100', now: 'n' }).s,
    ).toBe('120');
    // bigint-safe comparison
    expect(
      advanceCursor(
        { ...cursor, s: '9007199254740993' },
        { lastSeq: '9007199254740995', xmin: '1', now: 'n' },
      ).s,
    ).toBe('9007199254740995');
  });
});

describe('collectChanges (deltas and tombstones)', () => {
  it('groups variants, products, customers and context changes', () => {
    const set = collectChanges(
      [
        row(1, 'variant', 'v1'),
        row(2, 'product', 'p1'),
        row(3, 'customer', 'c1'),
        row(4, 'category', 'cat1'),
        row(5, 'stock', 'v2', 'U', 'loc-1'),
        row(6, 'stock', 'v3', 'U', 'loc-other'),
      ],
      'loc-1',
    );
    expect(set).toEqual({
      variantIds: ['v1', 'v2'],
      deletedVariantIds: [],
      productIds: ['p1'],
      customerIds: ['c1'],
      deletedCustomerIds: [],
      contextChanged: true,
      priceListsChanged: false,
    });
  });

  it('turns deletions into tombstones, unless re-created later', () => {
    const set = collectChanges(
      [
        row(10, 'variant', 'v1', 'D'),
        row(11, 'variant', 'v2', 'D'),
        row(12, 'variant', 'v2', 'U'),
        row(13, 'customer', 'c9', 'D'),
      ],
      null,
    );
    expect(set.deletedVariantIds).toEqual(['v1']);
    expect(set.variantIds).toEqual(['v2']);
    expect(set.deletedCustomerIds).toEqual(['c9']);
  });

  it('applies rows in seq order whatever order they were read in', () => {
    // Replayed rows (older seq) come after fresh ones in the read
    const set = collectChanges(
      [row(20, 'variant', 'v1', 'U'), row(15, 'variant', 'v1', 'D')],
      null,
    );
    expect(set.variantIds).toEqual(['v1']);
    expect(set.deletedVariantIds).toEqual([]);
  });

  it('signals price list changes (full download)', () => {
    expect(
      collectChanges([row(1, 'price_list', 'pl1')], null).priceListsChanged,
    ).toBe(true);
  });

  it('ignores stock changes when the register has no location', () => {
    expect(
      collectChanges([row(1, 'stock', 'v1', 'U', 'loc-1')], null).variantIds,
    ).toEqual([]);
  });
});
