import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DataSource } from 'typeorm';
import type { Writable } from 'stream';
import { readFile } from 'fs/promises';
import type { AuditService } from '../audit/audit.service';
import type { StorageService } from '../storage/storage.service';
import { ReportRunnerService } from '../reports/report-runner.service';
import { ExportsService, pickParams } from './exports.service';
import { ExportWorkerService } from './export-worker.service';
import { SavedFiltersService } from './saved-filters.service';
import {
  ExportJobRow,
  fileExpiry,
  isDownloadable,
  jobView,
  signDownloadToken,
  verifyDownloadToken,
} from './export-logic';

const TENANT = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const JOB = '33333333-3333-3333-3333-333333333333';
const SECRET = 'x'.repeat(40);
const EXPORTER = ['reports.view', 'reports.export'];
const RANGE = { from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' };

const config = {
  get: (name: string) => (name === 'JWT_SECRET' ? SECRET : undefined),
} as unknown as ConfigService;

function job(overrides: Partial<ExportJobRow> = {}): ExportJobRow {
  return {
    id: JOB,
    tenantId: TENANT,
    userId: USER,
    reportKey: 'sales-by-day',
    params: RANGE,
    scope: null,
    format: 'csv',
    status: 'queued',
    attempts: 0,
    rowCount: null,
    fileKey: null,
    fileName: null,
    fileSize: null,
    startedAt: null,
    finishedAt: null,
    expiresAt: null,
    error: null,
    created_at: new Date(),
    ...overrides,
  };
}

// A real runner for access checks; file generation is stubbed
function makeRunner() {
  const runner = new ReportRunnerService(
    { query: jest.fn() } as unknown as DataSource,
    { record: jest.fn() } as unknown as AuditService,
  );
  jest.spyOn(runner, 'writeFile').mockImplementation(
    (_t: string, _p: unknown, _f: unknown, out: Writable) =>
      new Promise<number>((resolve) => {
        out.end('Date,Sales\r\n2026-09-01,3', () => resolve(1));
      }),
  );
  return runner;
}

function makeStorage() {
  const stored: { key: string; body: string }[] = [];
  return {
    stored,
    storage: {
      newPrivateKey: jest.fn(
        (prefix: string, ext: string) => `private/${prefix}/abc.${ext}`,
      ),
      putPrivateFile: jest.fn(async (key: string, path: string) => {
        stored.push({ key, body: await readFile(path, 'utf8') });
      }),
      privateDownloadUrl: jest.fn(() => Promise.resolve(null)),
      deletePrivate: jest.fn(() => Promise.resolve()),
      privateLocalPath: jest.fn((key: string) => `/files/${key}`),
    } as unknown as StorageService & {
      putPrivateFile: jest.Mock;
      deletePrivate: jest.Mock;
    },
  };
}

const mocks = (storage: StorageService) =>
  storage as unknown as Record<string, jest.Mock>;

describe('export job lifecycle (spec §14)', () => {
  it('queues a job after checking the report and access', async () => {
    const query = jest.fn(() => Promise.resolve([job()]));
    const audit = { record: jest.fn() };
    const service = new ExportsService(
      { query } as unknown as DataSource,
      makeRunner(),
      makeStorage().storage,
      audit as unknown as AuditService,
      config,
    );
    const view = await service.create(
      TENANT,
      USER,
      { reportKey: 'sales-by-day', format: 'csv', params: RANGE },
      EXPORTER,
    );
    expect(view).toMatchObject({ id: JOB, status: 'queued' });
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('INSERT INTO export_jobs');
    expect(values).toEqual([
      TENANT,
      USER,
      'sales-by-day',
      JSON.stringify(RANGE),
      null,
      'csv',
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'report.export_queued' }),
    );

    // Refused up front: a report the user can't run, missing dates
    await expect(
      service.create(
        TENANT,
        USER,
        { reportKey: 'audit-activity', format: 'pdf', params: RANGE },
        EXPORTER,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.create(
        TENANT,
        USER,
        { reportKey: 'nope', format: 'csv' },
        EXPORTER,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('claims with SKIP LOCKED, builds the file, stores it privately and sets its expiry', async () => {
    const calls: string[] = [];
    const query = jest.fn((sql: string) => {
      calls.push(sql);
      if (sql.includes('FOR UPDATE SKIP LOCKED LIMIT 1')) {
        return Promise.resolve(
          calls.filter((c) => c.includes('SKIP LOCKED LIMIT 1')).length === 1
            ? [[job({ status: 'running', attempts: 1 })], 1]
            : [[], 0],
        );
      }
      if (sql.includes('FROM tenant_memberships')) {
        return Promise.resolve([{ role: 'manager', permissions: EXPORTER }]);
      }
      return Promise.resolve([]);
    });
    const { storage, stored } = makeStorage();
    const worker = new ExportWorkerService(
      { query } as unknown as DataSource,
      makeRunner(),
      storage,
      { record: jest.fn() } as unknown as AuditService,
      config,
    );

    expect(await worker.tick()).toBe(1);
    expect(stored).toEqual([
      {
        key: `private/exports/${TENANT}/abc.csv`,
        body: 'Date,Sales\r\n2026-09-01,3',
      },
    ]);
    const done = query.mock.calls.find(([sql]) =>
      sql.includes("status = 'done'"),
    ) as unknown as [string, unknown[]];
    expect(done[1][0]).toBe(JOB);
    expect(done[1][1]).toBe(1); // rowCount
    const [finishedAt, expiresAt] = [done[1][5] as Date, done[1][6] as Date];
    expect(expiresAt.getTime() - finishedAt.getTime()).toBe(24 * 3_600_000);
    expect(done[1][3]).toBe('sales-by-day-2026-09-01-to-2026-09-30.csv');
  });

  it('fails the job when the user lost the export permission', async () => {
    const query = jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('FROM tenant_memberships')
          ? [{ role: 'cashier', permissions: ['reports.view'] }]
          : [],
      ),
    );
    const { storage } = makeStorage();
    const worker = new ExportWorkerService(
      { query } as unknown as DataSource,
      makeRunner(),
      storage,
      { record: jest.fn() } as unknown as AuditService,
      config,
    );
    await worker.process(job({ status: 'running' }));
    const failed = query.mock.calls.find(([sql]) =>
      sql.includes("status = 'failed'"),
    ) as unknown as [string, unknown[]];
    expect(failed[1][1]).toMatch(/no longer export/);
    expect(mocks(storage).putPrivateFile).not.toHaveBeenCalled();
  });

  it('deletes expired files and requeues abandoned jobs', async () => {
    const query = jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('WITH due AS')
          ? [{ id: JOB, oldKey: `private/exports/${TENANT}/abc.csv` }]
          : [],
      ),
    );
    const { storage } = makeStorage();
    const worker = new ExportWorkerService(
      { query } as unknown as DataSource,
      makeRunner(),
      storage,
      { record: jest.fn() } as unknown as AuditService,
      config,
    );
    expect(await worker.deleteExpired()).toBe(1);
    expect(mocks(storage).deletePrivate).toHaveBeenCalledWith(
      `private/exports/${TENANT}/abc.csv`,
    );
    expect(query.mock.calls[0][0]).toContain('"expiresAt" <= now()');
    await worker.requeueStale();
    expect(query.mock.calls[1][0]).toMatch(
      /status = 'running' AND "startedAt" < now\(\)/,
    );
  });

  describe('download', () => {
    const ready = job({
      status: 'done',
      fileKey: `private/exports/${TENANT}/abc.csv`,
      fileName: 'sales-by-day.csv',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const makeService = (row: ExportJobRow) =>
      new ExportsService(
        {
          query: jest.fn(() => Promise.resolve([row])),
        } as unknown as DataSource,
        makeRunner(),
        makeStorage().storage,
        { record: jest.fn() } as unknown as AuditService,
        config,
      );

    it('issues a short-lived signed link, re-checking the permission', async () => {
      const service = makeService(ready);
      const result = await service.get(TENANT, USER, JOB, EXPORTER);
      expect(result.status).toBe('done');
      const token = /\/exports\/download\/(.+)$/.exec(result.downloadUrl!)![1];
      expect(verifyDownloadToken(SECRET, token)).toBe(JOB);
      const expiresAt = (result as { downloadUrlExpiresAt?: Date })
        .downloadUrlExpiresAt!;
      const ttl = expiresAt.getTime() - Date.now();
      expect(ttl).toBeGreaterThan(14 * 60_000);
      expect(ttl).toBeLessThanOrEqual(15 * 60_000);
      await expect(service.resolveDownload(token)).resolves.toMatchObject({
        fileName: 'sales-by-day.csv',
      });

      // Permission removed since the export was made: no link
      await expect(
        service.get(TENANT, USER, JOB, ['reports.view']),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('gives no link once the file expired', async () => {
      const expired = { ...ready, expiresAt: new Date(Date.now() - 1000) };
      const service = makeService(expired);
      const result = await service.get(TENANT, USER, JOB, EXPORTER);
      expect(result).toMatchObject({ status: 'expired', downloadUrl: null });
      const token = signDownloadToken(
        SECRET,
        JOB,
        new Date(Date.now() + 60_000),
      );
      await expect(service.resolveDownload(token)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});

describe('export rules', () => {
  it('signs tokens that expire and cannot be forged', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    const token = signDownloadToken(
      SECRET,
      JOB,
      new Date(now.getTime() + 900_000),
    );
    expect(verifyDownloadToken(SECRET, token, now)).toBe(JOB);
    expect(
      verifyDownloadToken(SECRET, token, new Date(now.getTime() + 900_001)),
    ).toBeNull();
    expect(verifyDownloadToken('another-secret', token, now)).toBeNull();
    const [payload] = token.split('.');
    expect(verifyDownloadToken(SECRET, `${payload}.forged`, now)).toBeNull();
    expect(verifyDownloadToken(SECRET, 'garbage', now)).toBeNull();
  });

  it('knows when a file can be downloaded', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    const finished = new Date('2026-09-25T11:00:00Z');
    const done = job({
      status: 'done',
      fileKey: 'k',
      expiresAt: fileExpiry(finished),
    });
    expect(isDownloadable(done, now)).toBe(true);
    expect(isDownloadable(done, new Date('2026-09-26T11:00:01Z'))).toBe(false);
    expect(jobView(done, new Date('2026-09-26T11:00:01Z')).status).toBe(
      'expired',
    );
    expect(jobView(done, now)).not.toHaveProperty('fileKey');
  });

  it('keeps only report parameters', () => {
    expect(
      pickParams({
        ...RANGE,
        branchId: 'b',
        evil: 'x',
      } as unknown as typeof RANGE),
    ).toEqual({ ...RANGE, branchId: 'b' });
  });
});

describe('saved report filters', () => {
  const row = {
    id: JOB,
    userId: USER,
    reportKey: 'sales-by-day',
    name: 'Last week',
    params: { preset: '7d' },
    shared: true,
    created_at: new Date(),
    updated_at: new Date(),
  };

  it('creates, lists (mine and shared), updates and deletes', async () => {
    const query = jest.fn((sql: string) => {
      if (sql.startsWith('INSERT')) return Promise.resolve([row]);
      if (sql.includes('UPDATE'))
        return Promise.resolve([[{ ...row, name: 'Week' }], 1]);
      if (sql.startsWith('DELETE')) return Promise.resolve([[{ id: JOB }], 1]);
      return Promise.resolve([
        { ...row, userId: 'someone-else', ownerName: 'Ana' },
      ]);
    });
    const service = new SavedFiltersService({ query } as unknown as DataSource);

    const created = await service.create(TENANT, USER, {
      reportKey: 'sales-by-day',
      name: ' Last week ',
      params: { preset: '7d', evil: 1 } as never,
      shared: true,
    });
    expect(created).toMatchObject({
      name: 'Last week',
      shared: true,
      mine: true,
    });
    const insert = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(insert[1]).toEqual([
      TENANT,
      USER,
      'sales-by-day',
      'Last week',
      '{"preset":"7d"}',
      true,
    ]);

    const list = await service.list(TENANT, USER, 'sales-by-day');
    expect(list[0]).toMatchObject({ mine: false, ownerName: 'Ana' });
    expect(query.mock.calls[1][0]).toContain('f.shared');

    await expect(
      service.update(TENANT, USER, JOB, {
        reportKey: 'sales-by-day',
        name: 'Week',
        params: {},
      }),
    ).resolves.toMatchObject({ name: 'Week' });
    // Only the owner changes or deletes
    expect(query.mock.calls[2][0]).toContain('"userId" = $3');
    await service.remove(TENANT, USER, JOB);
    expect(query.mock.calls[3][0]).toContain('"userId" = $3');
  });

  it('rejects unknown reports, duplicates and filters of others', async () => {
    const service = new SavedFiltersService({
      query: jest.fn((sql: string) =>
        sql.startsWith('INSERT')
          ? Promise.reject(Object.assign(new Error('dup'), { code: '23505' }))
          : Promise.resolve([[], 0]),
      ),
    } as unknown as DataSource);
    await expect(
      service.create(TENANT, USER, {
        reportKey: 'nope',
        name: 'x',
        params: {},
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.create(TENANT, USER, {
        reportKey: 'sales-by-day',
        name: 'x',
        params: {},
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(service.remove(TENANT, USER, JOB)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
