import { EntityManager } from 'typeorm';
import { branchDocumentPrefix, nextDocumentNumber } from './sequence';

describe('nextDocumentNumber', () => {
  // First use of a sequence: no counter row yet → lock, seed from the highest
  // stored number, create the counter
  const firstUse = (max: number | null) => {
    const query = jest
      .fn<Promise<unknown>, [string, unknown[]]>()
      .mockResolvedValueOnce([[], 0]) // UPDATE counter: no row
      .mockResolvedValueOnce([]) // advisory lock
      .mockResolvedValueOnce([{ max }]) // highest stored number
      .mockResolvedValueOnce([{ lastValue: String((max ?? 0) + 1) }]); // INSERT counter
    return { query, manager: { query } as unknown as EntityManager };
  };

  it('takes the next number from the counter in one update when it exists', async () => {
    const query = jest
      .fn<Promise<unknown>, [string, unknown[]]>()
      .mockResolvedValueOnce([[{ lastValue: '42' }], 1]);
    const number = await nextDocumentNumber(
      { query } as unknown as EntityManager,
      { table: 'sales', column: 'saleNumber', tenantId: 't1', prefix: 'MAIN' },
    );
    expect(number).toBe('MAIN-000042');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('UPDATE document_sequences');
    expect(query.mock.calls[0][1]).toEqual(['t1', 'sales:saleNumber:MAIN']);
  });

  it('seeds a new counter from the highest stored number, under a lock', async () => {
    const { query, manager } = firstUse(41);
    const number = await nextDocumentNumber(manager, {
      table: 'sales',
      column: 'saleNumber',
      tenantId: 't1',
      prefix: 'MAIN',
    });
    expect(number).toBe('MAIN-000042');
    expect(query.mock.calls[1]).toEqual([
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      ['sales:t1:MAIN'],
    ]);
    expect(query.mock.calls[2][1]).toEqual(['t1', '^MAIN-[0-9]+$', 6]);
    // Created at max + 1, or bumped if another caller created it meanwhile
    expect(query.mock.calls[3][0]).toContain('ON CONFLICT');
    expect(query.mock.calls[3][1]).toEqual(['t1', 'sales:saleNumber:MAIN', 42]);
  });

  it('gives each branch its own sequence', async () => {
    const a = firstUse(null);
    const b = firstUse(7);
    const opts = { table: 'sales', column: 'saleNumber', tenantId: 't1' };
    await expect(
      nextDocumentNumber(a.manager, { ...opts, prefix: 'NORD' }),
    ).resolves.toBe('NORD-000001');
    await expect(
      nextDocumentNumber(b.manager, { ...opts, prefix: 'SUD' }),
    ).resolves.toBe('SUD-000008');
    expect(a.query.mock.calls[0][1]).toEqual(['t1', 'sales:saleNumber:NORD']);
    expect(b.query.mock.calls[0][1]).toEqual(['t1', 'sales:saleNumber:SUD']);
  });

  it('numbers returns per branch with the -R suffix, not matching sales numbers', async () => {
    const { query, manager } = firstUse(2);
    await expect(
      nextDocumentNumber(manager, {
        table: 'sale_returns',
        column: 'returnNumber',
        tenantId: 't1',
        prefix: 'MAIN-R',
      }),
    ).resolves.toBe('MAIN-R-000003');
    expect(query.mock.calls[2][1]).toEqual(['t1', '^MAIN-R-[0-9]+$', 8]);
  });

  it('escapes regex characters of the prefix', async () => {
    const { query, manager } = firstUse(0);
    await nextDocumentNumber(manager, {
      table: 'sales',
      column: 'saleNumber',
      tenantId: 't1',
      prefix: 'A.B',
    });
    expect(query.mock.calls[2][1][1]).toBe('^A\\.B-[0-9]+$');
  });
});

describe('branchDocumentPrefix', () => {
  it('upper-cases the branch code and keeps letters, digits and dashes', () => {
    expect(branchDocumentPrefix('main')).toBe('MAIN');
    expect(branchDocumentPrefix('Port au Prince #2')).toBe('PORTAUPRINCE2');
    expect(branchDocumentPrefix('pv-01')).toBe('PV-01');
  });

  it('never reads like a provisional number', () => {
    expect(branchDocumentPrefix('h')).toBe('B-H');
    expect(branchDocumentPrefix('P')).toBe('B-P');
    expect(branchDocumentPrefix('offline')).toBe('B-OFFLINE');
  });

  it('falls back when the code has nothing usable, and caps the length', () => {
    expect(branchDocumentPrefix('')).toBe('B');
    expect(branchDocumentPrefix(null)).toBe('B');
    expect(branchDocumentPrefix('X'.repeat(40))).toHaveLength(20);
  });
});
