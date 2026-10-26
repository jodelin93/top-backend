import type { DataSource } from 'typeorm';
import { inStoreTime, storeTimezone } from './report-period';

const TENANT = '11111111-1111-1111-1111-111111111111';

const db = (timezone: string | null, bounds: object = {}) => {
  const query = jest.fn((sql: string) =>
    Promise.resolve(sql.includes('FROM branches') ? [{ timezone }] : [bounds]),
  );
  return { query, source: { query } as unknown as DataSource };
};

describe('report periods in store time', () => {
  it("uses the branch's time zone, UTC when it is missing or unknown", async () => {
    expect(
      await storeTimezone(db('America/Port-au-Prince').source, TENANT),
    ).toBe('America/Port-au-Prince');
    expect(await storeTimezone(db(null).source, TENANT)).toBe('UTC');
    expect(await storeTimezone(db('Mars/Olympus').source, TENANT)).toBe('UTC');
  });

  it("keeps the caller's time zone and full timestamps as they are", async () => {
    const { query: calls, source } = db('America/Port-au-Prince');
    const query = {
      from: '2026-10-01T04:00:00.000Z',
      to: '2026-10-02T03:59:59.999Z',
      timezone: 'Europe/Paris',
    };
    expect(await inStoreTime(source, TENANT, query)).toEqual(query);
    expect(calls).not.toHaveBeenCalled();
  });

  it('turns date-only bounds into whole local days', async () => {
    const { query: calls, source } = db('America/Port-au-Prince', {
      from: new Date('2026-10-25T04:00:00Z'),
      to: new Date('2026-10-26T03:59:59.999Z'),
    });
    const resolved = await inStoreTime(source, TENANT, {
      from: '2026-10-25',
      to: '2026-10-25',
    });
    expect(resolved).toEqual({
      from: '2026-10-25T04:00:00.000Z',
      to: '2026-10-26T03:59:59.999Z',
      timezone: 'America/Port-au-Prince',
    });
    expect(calls).toHaveBeenLastCalledWith(expect.any(String), [
      '2026-10-25',
      '2026-10-25',
      'America/Port-au-Prince',
    ]);
  });
});
