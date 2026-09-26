import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ReconciliationDeps,
  ReconciliationJobsService,
  runChecks,
} from './reconciliation-jobs.service';

const TENANT = '11111111-1111-4111-8111-111111111111';

function deps(options: {
  saleIssues?: number;
  orphans?: number;
  drift?: boolean;
  stalled?: number;
}): ReconciliationDeps {
  const query = jest.fn((sql: string) => {
    if (sql.includes('FROM payments p JOIN sales s')) {
      return Promise.resolve(
        Array.from({ length: options.orphans ?? 0 }, (_, i) => ({
          reference: `S-${i}`,
          status: 'voided',
          paymentStatus: 'captured',
        })),
      );
    }
    if (sql.includes('FROM outbox_events')) {
      return Promise.resolve(
        Array.from({ length: options.stalled ?? 0 }, (_, i) => ({
          id: `e${i}`,
          eventType: 'shift.closed',
          attempts: 10,
          dead: true,
        })),
      );
    }
    return Promise.resolve([]);
  });
  return {
    dataSource: { query } as unknown as DataSource,
    reconciliation: {
      run: jest.fn(() =>
        Promise.resolve({
          checks: [
            {
              key: 'sale-payments',
              label: 'Payments cover each sale',
              issues: Array.from({ length: options.saleIssues ?? 0 }, () => ({
                reference: 'S-1',
                expected: 10,
                actual: 9,
                detail: null,
              })),
            },
          ],
        }),
      ) as never,
    },
    projection: {
      preview: jest.fn(() =>
        Promise.resolve({
          locationId: null,
          applied: false,
          levelDifferences: options.drift
            ? [
                {
                  variantId: 'v1',
                  locationId: 'l1',
                  sku: 'COLA',
                  productName: null,
                  locationCode: 'SHOP',
                  projected: 5,
                  ledger: 4,
                  difference: -1,
                },
              ]
            : [],
          variantDifferences: [],
          totals: { levels: options.drift ? 1 : 0, variants: 0 },
        }),
      ),
    },
  };
}

describe('runChecks', () => {
  it('runs sales reconciliation + captured payments + stock drift + outbox checks', async () => {
    const d = deps({ orphans: 1, drift: true });
    const results = await runChecks(
      d,
      TENANT,
      new Date('2026-03-02T00:00:00Z'),
    );
    expect(results.map((r) => [r.key, r.passed])).toEqual([
      ['sale-payments', true],
      ['captured-payment-sale', false],
      ['stock-projection', false],
      ['outbox-stalled', true],
    ]);
    expect(d.reconciliation.run).toHaveBeenCalledWith(TENANT, {
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-03-02T00:00:00.000Z',
    });
    expect(results[1].issues[0]).toEqual({
      reference: 'S-0',
      detail: 'sale voided, payment captured',
    });
    expect(results[2].issues[0]).toMatchObject({
      reference: 'COLA @ SHOP',
      expected: 4,
      actual: 5,
    });
  });
});

describe('ReconciliationJobsService.run', () => {
  const setup = (options: Parameters<typeof deps>[0]) => {
    const saved: Record<string, unknown>[] = [];
    const repo = {
      create: (value: Record<string, unknown>) => ({ ...value }),
      save: jest.fn((value: Record<string, unknown>) => {
        value.id ??= 'run-1';
        saved.push({ ...value });
        return Promise.resolve(value);
      }),
    };
    const dataSource = {
      getRepository: () => repo,
      query: jest.fn(() => Promise.resolve([])),
    } as unknown as DataSource;
    const notifications = {
      notify: jest.fn(() => Promise.resolve({ id: 'n', created: true })),
      resolve: jest.fn(() => Promise.resolve()),
    };
    const service = new ReconciliationJobsService(
      dataSource,
      notifications as unknown as NotificationsService,
      {} as AuditService,
    );
    Object.assign(service, { deps: deps(options) });
    return { service, notifications, saved };
  };

  it('stores the run and raises notifications for issues', async () => {
    const { service, notifications, saved } = setup({
      saleIssues: 2,
      stalled: 3,
    });
    const run = await service.run(TENANT, 'manual', 'user-1');

    expect(run.status).toBe('issues');
    expect(saved[0]).toMatchObject({ status: 'running', trigger: 'manual' });
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'reconciliation.issues',
        title: 'Reconciliation found issues in 1 check(s)',
        body: 'Payments cover each sale: 2 issue(s)',
        dedupeKey: 'reconciliation.issues',
        entityId: 'run-1',
      }),
    );
    expect(notifications.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'outbox.stalled',
        dedupeKey: 'outbox.stalled',
      }),
    );
  });

  it('a clean run clears earlier notifications', async () => {
    const { service, notifications } = setup({});
    const run = await service.run(TENANT, 'scheduled');
    expect(run.status).toBe('passed');
    expect(notifications.notify).not.toHaveBeenCalled();
    expect(notifications.resolve).toHaveBeenCalledWith(
      TENANT,
      'reconciliation.issues',
    );
    expect(notifications.resolve).toHaveBeenCalledWith(
      TENANT,
      'outbox.stalled',
    );
  });

  it('records a failed run instead of throwing', async () => {
    const { service } = setup({});
    const failing = deps({});
    (failing.projection.preview as jest.Mock).mockRejectedValue(
      new Error('location missing'),
    );
    Object.assign(service, { deps: failing });
    jest
      .spyOn(
        (service as unknown as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation();
    const run = await service.run(TENANT, 'manual');
    expect(run.status).toBe('failed');
    expect(run.error).toBe('location missing');
  });
});
