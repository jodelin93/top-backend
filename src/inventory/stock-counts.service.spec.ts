import { BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import {
  StockCount,
  StockCountStatus,
} from '../database/entities/stock-count.entity';
import { StockCountItem } from '../database/entities/stock-count-item.entity';
import { SettingsService } from '../settings/settings.service';
import { InventoryService } from './inventory.service';
import { StockCountsService } from './stock-counts.service';

/**
 * Submission of a count: variances are rolled forward over the movements
 * posted between the snapshot and each line's count, and posting never takes
 * stock below zero (D018).
 */
function setup(movements: { quantity: number; movementDate: string }[]) {
  const count: Partial<StockCount> = {
    id: 'cnt-1',
    tenantId: 't',
    countNumber: 'CNT-000001',
    locationId: 'loc',
    status: StockCountStatus.IN_PROGRESS,
    snapshotAt: new Date('2026-09-24T08:00:00Z'),
    notes: null,
  };
  const items: Partial<StockCountItem>[] = [
    {
      id: 'i-1',
      tenantId: 't',
      variantId: 'v-1',
      expectedQuantity: 10,
      countedQuantity: 8,
      countedAt: new Date('2026-09-24T10:00:00Z'),
      reason: null,
      variant: { cost: 2 } as never,
    },
  ];
  const manager = {
    findOne: jest.fn(() => Promise.resolve(count)),
    find: jest.fn(() => Promise.resolve(items)),
    query: jest.fn(() =>
      Promise.resolve(movements.map((m) => ({ variantId: 'v-1', ...m }))),
    ),
    update: jest.fn(),
    save: jest.fn((row: object) => Promise.resolve(row)),
  };
  const inventory = { applyMovement: jest.fn(() => Promise.resolve({})) };
  const service = new StockCountsService(
    {
      transaction: (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
    } as unknown as DataSource,
    inventory as unknown as InventoryService,
    {
      getSettings: () => Promise.resolve({ countVarianceTolerance: 0 }),
    } as unknown as SettingsService,
    { record: jest.fn() } as unknown as AuditService,
  );
  jest.spyOn(service, 'get').mockResolvedValue({} as never);
  return { service, count, items, inventory, manager };
}

describe('StockCountsService roll-forward', () => {
  it('a sale while counting is no variance: posted without approval, delta 0', async () => {
    // 2 sold at 09:00, the line counted at 10:00
    const { service, count, items, inventory, manager } = setup([
      { quantity: -2, movementDate: '2026-09-24T09:00:00Z' },
    ]);
    await service.submit('t', 'cnt-1', 'counter');
    expect(items[0]).toMatchObject({ movementsSinceSnapshot: -2, variance: 0 });
    expect(count.status).toBe(StockCountStatus.POSTED);
    expect(inventory.applyMovement).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        delta: 0,
        respectReservations: false,
        metadata: expect.objectContaining({
          expectedQuantity: 10,
          movementsSinceSnapshot: -2,
          countedQuantity: 8,
        }) as unknown,
      }),
    );
    // The count's own posting is excluded from its roll-forward
    expect(manager.query.mock.calls[0]).toEqual([
      expect.stringContaining(`NOT ("referenceType" = 'stock_count'`),
      expect.arrayContaining(['cnt-1']),
    ]);
  });

  it('a real shortage still needs approval above the tolerance', async () => {
    const { service, count, items } = setup([]);
    await service.submit('t', 'cnt-1', 'counter');
    expect(items[0].variance).toBe(-2);
    expect(count.status).toBe(StockCountStatus.PENDING_APPROVAL);
  });

  it('D018: a posting that would go below zero is refused', async () => {
    const { service, inventory, count } = setup([]);
    count.status = StockCountStatus.PENDING_APPROVAL;
    count.submittedById = 'counter';
    inventory.applyMovement.mockRejectedValueOnce(
      new BadRequestException('Not enough stock (0 on hand)'),
    );
    await expect(
      service.approve('t', 'cnt-1', 'counter', 'manager'),
    ).rejects.toThrow('Not enough stock');
  });
});
