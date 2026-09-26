import type { DataSource } from 'typeorm';
import { scheduleDaily } from '../platform/scheduling';
import { CHANGE_LOG_RETENTION, MAX_CURSOR_AGE_MS } from './sync-cursor';
import { SyncLogPruneService } from './sync-log-prune.service';

describe('SyncLogPruneService', () => {
  it('keeps longer than the oldest cursor still accepted', () => {
    const days = Number(/^(\d+) days$/.exec(CHANGE_LOG_RETENTION)?.[1]);
    expect(days * 24 * 3_600_000).toBeGreaterThan(MAX_CURSOR_AGE_MS);
  });

  it('deletes old rows in batches, keeping each store newest row', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([[], 10_000])
      .mockResolvedValueOnce([[], 42]);
    const service = new SyncLogPruneService({
      query,
    } as unknown as DataSource);
    expect(await service.prune()).toBe(10_042);
    expect(query).toHaveBeenCalledTimes(2);
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual([CHANGE_LOG_RETENTION]);
    expect(sql).toContain('changed_at < now() - $1::interval');
    // Never the newest row of a store (max(seq) must not go back)
    expect(sql).toContain('o.seq < (SELECT max(m.seq)');
  });

  it('runs once a day under an advisory lock, and can be switched off', () => {
    jest.useFakeTimers();
    try {
      const lock = jest.fn(() => Promise.resolve([{ locked: true }]));
      const job = jest.fn(() => Promise.resolve());
      const dataSource = {
        transaction: (work: (m: { query: typeof lock }) => Promise<unknown>) =>
          work({ query: lock }),
      } as unknown as DataSource;
      const stop = scheduleDaily(dataSource, {
        lockKey: 1,
        envSwitch: 'TEST_DAILY_JOB',
        firstRunAfterMs: 1000,
        job,
        onError: jest.fn(),
      });
      jest.advanceTimersByTime(1000);
      expect(lock).toHaveBeenCalledWith(
        'SELECT pg_try_advisory_xact_lock($1) AS locked',
        [1],
      );
      jest.advanceTimersByTime(24 * 3_600_000);
      expect(lock).toHaveBeenCalledTimes(2);
      stop();

      process.env.TEST_DAILY_JOB = 'off';
      const none = jest.fn();
      scheduleDaily(dataSource, {
        lockKey: 2,
        envSwitch: 'TEST_DAILY_JOB',
        job: none,
        onError: jest.fn(),
      });
      jest.advanceTimersByTime(48 * 3_600_000);
      expect(none).not.toHaveBeenCalled();
    } finally {
      delete process.env.TEST_DAILY_JOB;
      jest.useRealTimers();
    }
  });
});
