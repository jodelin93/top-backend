import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { PurchaseOrdersService } from './purchase-orders.service';
import { GoodsReceipt } from '../database/entities/goods-receipt.entity';
import { PurchaseOrder } from '../database/entities/purchase-order.entity';
import type { InventoryService } from '../inventory/inventory.service';

describe('PurchaseOrdersService.receive (duplicate protection)', () => {
  const dto = {
    idempotencyKey: 'receipt-key-1',
    items: [{ purchaseOrderItemId: 'line-1', quantity: 2 }],
  };
  const existingReceipt = {
    id: 'r1',
    purchaseOrderId: 'po-1',
    receiptNumber: 'GRN-000001',
    items: [],
  };

  function setup(found: (entity: unknown) => unknown) {
    const manager = {
      findOne: jest.fn((entity: unknown) => Promise.resolve(found(entity))),
      findOneOrFail: jest.fn(() => Promise.resolve({ id: 'po-1' })),
    };
    const transaction = jest.fn();
    const applyMovement = jest.fn();
    const service = new PurchaseOrdersService(
      { manager, transaction } as never,
      { record: jest.fn() } as never,
      { getSettings: jest.fn(() => Promise.resolve({})) } as never,
      { applyMovement } as unknown as InventoryService,
    );
    return { service, manager, transaction, applyMovement };
  }

  it('returns the first receipt for a retried key and posts nothing', async () => {
    const { service, transaction, applyMovement } = setup((entity) =>
      entity === GoodsReceipt ? existingReceipt : null,
    );
    const result = await service.receive('t', 'u', 'po-1', dto);
    expect(result.duplicate).toBe(true);
    expect(result.receipt).toBe(existingReceipt);
    expect(transaction).not.toHaveBeenCalled();
    expect(applyMovement).not.toHaveBeenCalled();
  });

  it('refuses a key already used for another order', async () => {
    const { service } = setup((entity) =>
      entity === GoodsReceipt
        ? { ...existingReceipt, purchaseOrderId: 'po-2' }
        : null,
    );
    await expect(service.receive('t', 'u', 'po-1', dto)).rejects.toThrow(
      ConflictException,
    );
  });

  it('returns the winner when a concurrent retry hits the unique key', async () => {
    let calls = 0;
    const { service, transaction } = setup((entity) => {
      if (entity !== GoodsReceipt) return null;
      calls++;
      // Not there before the transaction, there after the unique violation
      return calls === 1 ? null : existingReceipt;
    });
    const driverError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint: 'uq_goods_receipts_idempotency',
    });
    transaction.mockRejectedValue(
      new QueryFailedError('INSERT', [], driverError),
    );
    const result = await service.receive('t', 'u', 'po-1', dto);
    expect(result).toMatchObject({ duplicate: true, receipt: existingReceipt });
  });

  it('checks the key again after locking the order', async () => {
    let receiptLookups = 0;
    const { service, transaction, applyMovement } = setup(() => null);
    const txManager = {
      findOne: jest.fn((entity: unknown) => {
        if (entity === PurchaseOrder) {
          return Promise.resolve({ id: 'po-1', status: 'issued' });
        }
        receiptLookups++;
        return Promise.resolve(existingReceipt);
      }),
      findOneOrFail: jest.fn(() => Promise.resolve({ id: 'po-1' })),
    };
    transaction.mockImplementation((fn: (m: unknown) => unknown) =>
      fn(txManager),
    );
    const result = await service.receive('t', 'u', 'po-1', dto);
    expect(result.duplicate).toBe(true);
    expect(receiptLookups).toBe(1);
    expect(applyMovement).not.toHaveBeenCalled();
  });
});
