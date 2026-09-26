import { LocationStockStatus } from '../database/entities/inventory-location.entity';
import {
  agingBucket,
  canGoOut,
  countsAsAvailable,
  daysSince,
  defaultSourceKey,
  eventKey,
  isSameMovement,
  locationStatusFields,
  pickConditionLocation,
  SOURCE_KEY_MAX,
  sourceKeyWithOccurrence,
} from './stock-rules';

describe('D018: canGoOut', () => {
  it('refuses to take available stock below zero', () => {
    expect(canGoOut({ quantityOnHand: 5, quantityReserved: 0 }, 5)).toBeNull();
    expect(canGoOut({ quantityOnHand: 5, quantityReserved: 0 }, 6)).toBe(
      'Not enough stock (5 available)',
    );
    expect(canGoOut({ quantityOnHand: 5, quantityReserved: 3 }, 3)).toBe(
      'Not enough stock (2 available)',
    );
  });

  it('can ignore reservations (counts, adjustments) but never on hand', () => {
    const level = { quantityOnHand: 5, quantityReserved: 3 };
    expect(canGoOut(level, 5, { respectReservations: false })).toBeNull();
    expect(canGoOut(level, 6, { respectReservations: false })).toBe(
      'Not enough stock (5 on hand)',
    );
  });

  it('refuses anything out of a location already below zero', () => {
    expect(canGoOut({ quantityOnHand: -2, quantityReserved: 0 }, 1)).toBe(
      'Not enough stock (0 available)',
    );
    expect(canGoOut({ quantityOnHand: -2, quantityReserved: 0 }, 0)).toBeNull();
  });
});

describe('ledger source keys', () => {
  it('derives the default key from the reference, variant, location and type', () => {
    expect(
      defaultSourceKey({
        referenceType: 'goods_receipt',
        referenceId: 'gr-1',
        variantId: 'v-1',
        locationId: 'l-1',
        movementType: 'purchase',
      }),
    ).toBe('goods_receipt:gr-1:v-1:l-1:purchase');
    // Nothing identifies an unreferenced movement
    expect(
      defaultSourceKey({
        variantId: 'v',
        locationId: 'l',
        movementType: 'purchase',
      }),
    ).toBeNull();
  });

  it('numbers repeats and keeps keys within the column size', () => {
    expect(sourceKeyWithOccurrence('k', 1)).toBe('k');
    expect(sourceKeyWithOccurrence('k', 3)).toBe('k#3');
    const long = 'x'.repeat(SOURCE_KEY_MAX);
    expect(sourceKeyWithOccurrence(long, 2)).toHaveLength(SOURCE_KEY_MAX);
    expect(eventKey('stock_transfer', 't', 'e', 'i')).toBe(
      'stock_transfer:t:e:i',
    );
  });

  it('only treats the same signed quantity at the location as already applied', () => {
    const out = { quantity: 3, fromLocationId: 'l', toLocationId: null };
    expect(isSameMovement(out, 'l', -3)).toBe(true);
    expect(isSameMovement(out, 'l', 3)).toBe(false);
    expect(isSameMovement(out, 'l', -2)).toBe(false);
    expect(isSameMovement(out, 'other', -3)).toBe(false);
  });
});

describe('location stock status', () => {
  it('only sellable locations count as available', () => {
    expect(countsAsAvailable(LocationStockStatus.SELLABLE)).toBe(true);
    for (const status of [
      LocationStockStatus.QUARANTINE,
      LocationStockStatus.DAMAGED,
      LocationStockStatus.TRANSIT,
    ]) {
      expect(countsAsAvailable(status)).toBe(false);
    }
  });

  it('keeps isSellable in line with stockStatus', () => {
    expect(
      locationStatusFields({ stockStatus: LocationStockStatus.DAMAGED }),
    ).toEqual({ stockStatus: 'damaged', isSellable: false });
    expect(locationStatusFields({ isSellable: false })).toEqual({
      isSellable: false,
      stockStatus: 'quarantine',
    });
    expect(locationStatusFields({})).toEqual({});
  });

  it('sends damaged goods to the damaged, else quarantine, location of the warehouse', () => {
    const shelf = { id: 'shelf', stockStatus: LocationStockStatus.SELLABLE };
    const quarantine = {
      id: 'q',
      stockStatus: LocationStockStatus.QUARANTINE,
    };
    const damaged = { id: 'd', stockStatus: LocationStockStatus.DAMAGED };
    expect(pickConditionLocation('shelf', 'good', [shelf, damaged])).toBe(
      'shelf',
    );
    expect(pickConditionLocation('shelf', 'damaged', [shelf, quarantine])).toBe(
      'q',
    );
    expect(
      pickConditionLocation('shelf', 'damaged', [shelf, quarantine, damaged]),
    ).toBe('d');
    expect(pickConditionLocation('shelf', 'damaged', [shelf])).toBe('shelf');
  });
});

describe('stock aging', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  it('counts whole days since the last receipt', () => {
    expect(daysSince('2026-09-24T01:00:00Z', now)).toBe(0);
    expect(daysSince('2026-08-25T12:00:00Z', now)).toBe(30);
    expect(daysSince(null, now)).toBeNull();
  });

  it('buckets the ages', () => {
    expect(agingBucket(0)).toBe('0-30');
    expect(agingBucket(30)).toBe('0-30');
    expect(agingBucket(31)).toBe('31-60');
    expect(agingBucket(90)).toBe('61-90');
    expect(agingBucket(180)).toBe('91-180');
    expect(agingBucket(400)).toBe('181+');
    expect(agingBucket(null)).toBe('unknown');
  });
});
