import { DataSource } from 'typeorm';
import { SettingsService } from '../settings/settings.service';
import { PosService } from '../sales/pos.service';
import { Register } from '../database/entities/register.entity';
import { Customer } from '../database/entities/customer.entity';
import { ChangeRow, decodeCursor, encodeCursor } from './sync-cursor';
import { SyncService } from './sync.service';

const register = {
  id: 'reg-1',
  branchId: 'br-1',
  defaultLocationId: 'loc-1',
} as Register;

const row = (
  seq: number,
  entity: string,
  entityId: string,
  op: 'U' | 'D' = 'U',
  scope: string | null = null,
): ChangeRow => ({
  seq: String(seq),
  entity,
  entityId,
  op,
  scope,
});

describe('SyncService.changes (change-log deltas)', () => {
  let replay: ChangeRow[];
  let fresh: ChangeRow[];
  let managerQuery: jest.Mock;
  let catalogItemsFor: jest.Mock;
  let service: SyncService;

  beforeEach(() => {
    replay = [];
    fresh = [];
    managerQuery = jest.fn((sql: string) => {
      if (sql.includes('pg_snapshot_xmin')) {
        return Promise.resolve([
          { xmin: '500', now: '2026-09-24T12:00:00.000000Z', maxSeq: '40' },
        ]);
      }
      if (sql.includes('txid >=')) return Promise.resolve(replay);
      return Promise.resolve(fresh);
    });
    catalogItemsFor = jest.fn((_t: string, ids: string[]) =>
      // v-hidden is no longer sold at the register's branch
      Promise.resolve(
        ids
          .filter((id) => id !== 'v-hidden')
          .map((variantId) => ({ variantId })),
      ),
    );
    const dataSource = {
      transaction: (_level: string, work: (m: unknown) => Promise<unknown>) =>
        work({ query: managerQuery }),
      getRepository: (entity: unknown) => ({
        findOne: () => Promise.resolve(entity === Register ? register : null),
        find: () =>
          Promise.resolve(
            entity === Customer
              ? [
                  {
                    id: 'c1',
                    code: 'C1',
                    status: 'active',
                    loyaltyPoints: '5',
                    email: 'ana@example.com',
                    phone: '509-1234',
                  },
                  { id: 'c2', code: 'C2', status: 'inactive' },
                ]
              : [],
          ),
      }),
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql.includes('product_variants') ? [{ id: 'v-from-product' }] : [],
        ),
      ),
    };
    service = new SyncService(
      dataSource as unknown as DataSource,
      {
        getSettings: jest.fn(),
        getDefaultTaxRate: jest.fn(),
      } as unknown as SettingsService,
      { catalogItemsFor } as unknown as PosService,
    );
  });

  const cursor = (s = '10', x = '400') =>
    encodeCursor({
      v: 2,
      s,
      x,
      r: 'reg-1',
      b: 'br-1',
      at: '2026-09-24T11:59:00.000000Z',
    });

  it('first sync: reset with a cursor at the snapshot boundary', async () => {
    const result = await service.changes('t1', { registerId: 'reg-1' });
    expect(result).toMatchObject({
      reset: true,
      resetReason: 'first_sync',
      items: [],
    });
    expect(decodeCursor(result.cursor)).toMatchObject({
      s: '40',
      x: '500',
      r: 'reg-1',
      b: 'br-1',
    });
  });

  it('delivers upserts and tombstones, then advances the cursor', async () => {
    fresh = [
      row(11, 'variant', 'v1'),
      row(12, 'variant', 'v-gone', 'D'),
      row(13, 'product', 'p1'),
      row(14, 'variant', 'v-hidden'),
      row(15, 'customer', 'c1'),
      row(16, 'customer', 'c2'),
      row(17, 'customer', 'c3', 'D'),
    ];
    const result = await service.changes('t1', {
      registerId: 'reg-1',
      cursor: cursor(),
    });
    expect(result.reset).toBe(false);
    expect(result.items.map((i) => i.variantId).sort()).toEqual([
      'v-from-product',
      'v1',
    ]);
    expect(result.removedVariantIds.sort()).toEqual(['v-gone', 'v-hidden']);
    expect(result.customers.map((c) => c.id)).toEqual(['c1']);
    // Contact details never go to the tills
    expect(result.customers[0]).not.toHaveProperty('email');
    expect(result.customers[0]).not.toHaveProperty('phone');
    expect(result.removedCustomerIds.sort()).toEqual(['c2', 'c3']);
    expect(result.context).toBeNull();
    expect(decodeCursor(result.cursor)).toMatchObject({ s: '17', x: '500' });
    // Branch assortment and stock come from the register
    expect(catalogItemsFor).toHaveBeenCalledWith(
      't1',
      expect.any(Array),
      register,
    );
  });

  it('re-reads rows of transactions that were running at the last read', async () => {
    replay = [row(8, 'variant', 'late')];
    const result = await service.changes('t1', {
      registerId: 'reg-1',
      cursor: cursor('10', '400'),
    });
    const calls = managerQuery.mock.calls as [string, unknown[]][];
    const replayCall = calls.find(([sql]) => sql.includes('txid >='));
    expect(replayCall?.[1]).toEqual(['t1', '10', '400']);
    expect(result.items.map((i) => i.variantId)).toEqual(['late']);
    // Nothing new past s: s stays, xmin moves on
    expect(decodeCursor(result.cursor)).toMatchObject({ s: '10', x: '500' });
  });

  it('pages: hasMore and a cursor after the last row of a full page', async () => {
    fresh = [
      row(11, 'variant', 'a'),
      row(12, 'variant', 'b'),
      row(13, 'variant', 'c'),
    ];
    const result = await service.changes('t1', {
      registerId: 'reg-1',
      cursor: cursor(),
      limit: 2,
    });
    expect(result.hasMore).toBe(true);
    expect(result.items.map((i) => i.variantId)).toEqual(['a', 'b']);
    expect(decodeCursor(result.cursor)?.s).toBe('12');
  });

  it('asks for a full download when price lists changed or the register moved', async () => {
    fresh = [row(11, 'price_list', 'pl1')];
    expect(
      (await service.changes('t1', { registerId: 'reg-1', cursor: cursor() }))
        .resetReason,
    ).toBe('price_lists_changed');
    const moved = encodeCursor({
      v: 2,
      s: '10',
      x: '400',
      r: 'reg-1',
      b: 'br-old',
      at: '2026-09-24T11:59:00.000000Z',
    });
    expect(
      (await service.changes('t1', { registerId: 'reg-1', cursor: moved }))
        .resetReason,
    ).toBe('register_changed');
  });
});
