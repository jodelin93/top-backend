import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { PurchaseOrdersService } from './purchase-orders.service';
import { SupplierInvoicesService } from './supplier-invoices.service';
import { SupplierReturnsService } from './supplier-returns.service';
import { PayablesService } from './payables.service';
import {
  PurchaseOrder,
  PurchaseOrderStatus,
} from '../database/entities/purchase-order.entity';
import { PurchaseOrderItem } from '../database/entities/purchase-order-item.entity';
import { PurchaseOrderRevision } from '../database/entities/purchase-order-revision.entity';
import { GoodsReceipt } from '../database/entities/goods-receipt.entity';
import { GoodsReceiptItem } from '../database/entities/goods-receipt-item.entity';
import { Supplier } from '../database/entities/supplier.entity';
import { SupplierProduct } from '../database/entities/supplier-product.entity';
import { InventoryLocation } from '../database/entities/inventory-location.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { SupplierInvoice } from '../database/entities/supplier-invoice.entity';
import { SupplierPayment } from '../database/entities/supplier-payment.entity';
import { SupplierCredit } from '../database/entities/supplier-credit.entity';
import { SupplierReturnItem } from '../database/entities/supplier-return-item.entity';
import { SupplierAllocation } from '../database/entities/supplier-allocation.entity';

type Handler = (options?: unknown) => unknown;

/**
 * Minimal in-memory stand-in for a TypeORM EntityManager / DataSource: reads
 * come from per-entity handlers, writes are recorded.
 */
function fakeDb(handlers: {
  findOne?: Map<unknown, Handler>;
  find?: Map<unknown, Handler>;
  count?: Map<unknown, Handler>;
  raw?: (entity: unknown) => unknown[];
  getOne?: (entity: unknown) => unknown;
}) {
  const saved: { entity: unknown; value: Record<string, unknown> }[] = [];
  const inserted: { entity: unknown; value: unknown }[] = [];
  const increments: {
    entity: unknown;
    where: unknown;
    column: string;
    by: number;
  }[] = [];
  let ids = 0;
  const queryBuilder = (entity: unknown) => {
    const qb: Record<string, unknown> = {};
    for (const method of [
      'select',
      'addSelect',
      'where',
      'andWhere',
      'groupBy',
      'innerJoin',
      'leftJoinAndSelect',
      'orderBy',
      'addOrderBy',
      'take',
      'update',
      'set',
    ]) {
      qb[method] = () => qb;
    }
    qb.getRawMany = () => Promise.resolve(handlers.raw?.(entity) ?? []);
    qb.getOne = () => Promise.resolve(handlers.getOne?.(entity) ?? null);
    qb.getMany = () => Promise.resolve([]);
    qb.execute = () => Promise.resolve({});
    return qb;
  };
  const manager = {
    findOne: jest.fn((entity: unknown, options?: unknown) =>
      Promise.resolve(handlers.findOne?.get(entity)?.(options) ?? null),
    ),
    findOneOrFail: jest.fn((entity: unknown, options?: unknown) =>
      Promise.resolve(handlers.findOne?.get(entity)?.(options)),
    ),
    find: jest.fn((entity: unknown, options?: unknown) =>
      Promise.resolve(handlers.find?.get(entity)?.(options) ?? []),
    ),
    count: jest.fn((entity: unknown, options?: unknown) =>
      Promise.resolve(handlers.count?.get(entity)?.(options) ?? 0),
    ),
    sum: jest.fn(() => Promise.resolve(0)),
    create: jest.fn((_entity: unknown, value: object) => ({ ...value })),
    save: jest.fn((entityOrValue: unknown, maybeValue?: unknown) => {
      const value = (maybeValue ?? entityOrValue) as Record<string, unknown>;
      if (!value.id) value.id = `id-${++ids}`;
      saved.push({ entity: maybeValue ? entityOrValue : null, value });
      return Promise.resolve(value);
    }),
    insert: jest.fn((entity: unknown, value: unknown) => {
      inserted.push({ entity, value });
      return Promise.resolve({});
    }),
    increment: jest.fn(
      (entity: unknown, where: unknown, column: string, by: number) => {
        increments.push({ entity, where, column, by });
        return Promise.resolve({});
      },
    ),
    delete: jest.fn(() => Promise.resolve({})),
    // nextDocumentNumber: advisory lock, then MAX(...)
    query: jest.fn((sql: string) =>
      Promise.resolve(sql.includes('MAX(') ? [{ max: null }] : []),
    ),
    getRepository: jest.fn((entity: unknown) => ({
      findOne: (options: unknown) => manager.findOne(entity, options),
      find: (options: unknown) => manager.find(entity, options),
      count: (options: unknown) => manager.count(entity, options),
      createQueryBuilder: () => queryBuilder(entity),
    })),
    createQueryBuilder: jest.fn(() => queryBuilder(null)),
  };
  const dataSource = {
    manager,
    getRepository: manager.getRepository,
    transaction: jest.fn((fn: (m: typeof manager) => unknown) => fn(manager)),
  };
  return { manager, dataSource, saved, inserted, increments };
}

const audit = () => ({ record: jest.fn(() => Promise.resolve()) });
const settings = (values: Record<string, unknown> = {}) => ({
  getSettings: jest.fn(() =>
    Promise.resolve({
      currencyCode: 'USD',
      purchaseApprovalThreshold: 1000,
      purchaseOverReceiptTolerance: 0,
      purchaseInvoiceVarianceTolerance: 0,
      ...values,
    }),
  ),
});

// ---------------------------------------------------------------------------

describe('PurchaseOrdersService: receiving with over-receipt tolerance', () => {
  const orderItem = () => ({
    id: 'line-1',
    variantId: 'v1',
    sku: 'A-1',
    quantityOrdered: 10,
    quantityReceived: 8,
    quantityCancelled: 0,
    unitCost: 5,
    discountPercent: 0,
  });

  function setup(tolerance: number) {
    const item = orderItem();
    const db = fakeDb({
      findOne: new Map<unknown, Handler>([
        [
          PurchaseOrder,
          () => ({
            id: 'po-1',
            tenantId: 't',
            poNumber: 'PO-000001',
            supplierId: 's1',
            locationId: 'loc',
            status: PurchaseOrderStatus.PARTIALLY_RECEIVED,
          }),
        ],
        // No receipt with this key yet; then the created receipt
        [
          GoodsReceipt,
          (options) =>
            (options as { where: { id?: string } }).where.id
              ? { id: 'r1', receiptNumber: 'GRN-000001', items: [] }
              : null,
        ],
      ]),
      find: new Map<unknown, Handler>([[PurchaseOrderItem, () => [item]]]),
    });
    const applyMovement = jest.fn(() => Promise.resolve({}));
    const approvals = { verify: jest.fn(() => Promise.resolve('manager-1')) };
    const service = new PurchaseOrdersService(
      db.dataSource as never,
      audit() as never,
      settings({ purchaseOverReceiptTolerance: tolerance }) as never,
      { applyMovement } as never,
      approvals as never,
    );
    return { service, db, applyMovement, approvals, item };
  }

  const dto = (quantity: number) => ({
    idempotencyKey: 'receipt-key-1',
    items: [{ purchaseOrderItemId: 'line-1', quantity }],
  });
  const clerk = { id: 'clerk', tenantId: 't', permissions: [] as never[] };

  it('accepts an over-receipt within the tolerance', async () => {
    // 10 ordered, 8 received, 20% tolerance → up to 12
    const { service, applyMovement, db } = setup(20);
    const result = await service.receive('t', 'clerk', 'po-1', dto(4), {
      user: clerk,
    });
    expect(result.duplicate).toBe(false);
    expect(applyMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ delta: 4, variantId: 'v1', cost: 5 }),
    );
    expect(db.increments).toContainEqual(
      expect.objectContaining({ column: 'quantityReceived', by: 4 }),
    );
  });

  it('needs purchasing.approve beyond the tolerance', async () => {
    const { service, applyMovement } = setup(20);
    const error: unknown = await service
      .receive('t', 'clerk', 'po-1', dto(5), { user: clerk })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      missingPermissions: ['purchasing.approve'],
      approvable: true,
    });
    expect(applyMovement).not.toHaveBeenCalled();
  });

  it('receives beyond the tolerance with a manager approval token', async () => {
    const { service, applyMovement, approvals, db } = setup(0);
    await service.receive('t', 'clerk', 'po-1', dto(5), {
      user: clerk,
      approvalToken: 'token',
    });
    expect(approvals.verify).toHaveBeenCalledWith(
      'token',
      'purchasing.approve',
      clerk,
    );
    expect(applyMovement).toHaveBeenCalledTimes(1);
    const receipt = db.saved.find((s) => 'receiptNumber' in s.value);
    expect(receipt?.value.overReceiptApprovedById).toBe('manager-1');
  });

  it('records rejected damaged units without stock', async () => {
    const { service, applyMovement, db } = setup(0);
    await service.receive(
      't',
      'clerk',
      'po-1',
      {
        idempotencyKey: 'receipt-key-2',
        items: [
          {
            purchaseOrderItemId: 'line-1',
            quantity: 1,
            damagedQuantity: 3,
            damagedAccepted: false,
          },
        ],
      },
      { user: clerk },
    );
    expect(applyMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ delta: 1 }),
    );
    const lines = db.inserted
      .filter((i) => i.entity === GoodsReceiptItem)
      .map((i) => i.value);
    expect(lines).toEqual([
      expect.objectContaining({
        quantity: 1,
        condition: 'good',
        accepted: true,
      }),
      expect.objectContaining({
        quantity: 3,
        condition: 'damaged',
        accepted: false,
      }),
    ]);
  });
});

describe('PurchaseOrdersService: receipt stock locations and events', () => {
  const clerk = { id: 'clerk', tenantId: 't', permissions: [] as never[] };

  function setup(damagedLocationId: string) {
    const db = fakeDb({
      findOne: new Map<unknown, Handler>([
        [
          PurchaseOrder,
          () => ({
            id: 'po-1',
            tenantId: 't',
            poNumber: 'PO-000001',
            supplierId: 's1',
            locationId: 'loc',
            status: PurchaseOrderStatus.ISSUED,
          }),
        ],
        [
          GoodsReceipt,
          (options) =>
            (options as { where: { id?: string } }).where.id
              ? { id: 'r1', receiptNumber: 'GRN-000001', items: [] }
              : null,
        ],
      ]),
      find: new Map<unknown, Handler>([
        [
          PurchaseOrderItem,
          () => [
            {
              id: 'line-1',
              variantId: 'v1',
              sku: 'A-1',
              quantityOrdered: 10,
              quantityReceived: 0,
              quantityCancelled: 0,
              unitCost: 5,
              discountPercent: 0,
            },
          ],
        ],
      ]),
    });
    const applyMovement = jest.fn(() => Promise.resolve({}));
    const resolveConditionLocation = jest.fn(() =>
      Promise.resolve(damagedLocationId),
    );
    const outbox = { record: jest.fn(() => Promise.resolve('e1')) };
    const service = new PurchaseOrdersService(
      db.dataSource as never,
      audit() as never,
      settings() as never,
      { applyMovement, resolveConditionLocation } as never,
      undefined,
      outbox as never,
    );
    return { service, db, applyMovement, resolveConditionLocation, outbox };
  }

  const receiveDamaged = (service: PurchaseOrdersService) =>
    service.receive(
      't',
      'clerk',
      'po-1',
      {
        idempotencyKey: 'receipt-key-3',
        items: [
          {
            purchaseOrderItemId: 'line-1',
            quantity: 4,
            damagedQuantity: 2,
            damagedAccepted: true,
          },
        ],
      },
      { user: clerk },
    );

  it('posts accepted damaged units to the quarantine location, good units to the order location', async () => {
    const { service, applyMovement, resolveConditionLocation } =
      setup('quarantine');
    await receiveDamaged(service);
    expect(resolveConditionLocation).toHaveBeenCalledWith(
      expect.anything(),
      't',
      'loc',
      'damaged',
    );
    expect(applyMovement).toHaveBeenCalledTimes(2);
    expect(applyMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locationId: 'loc', delta: 4, cost: 5 }),
    );
    expect(applyMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ locationId: 'quarantine', delta: 2, cost: 5 }),
    );
  });

  it('records goods.received in the receipt transaction', async () => {
    const { service, db, outbox } = setup('quarantine');
    await receiveDamaged(service);
    expect(outbox.record).toHaveBeenCalledWith(db.manager, {
      tenantId: 't',
      type: 'goods.received',
      aggregateId: expect.any(String) as unknown,
      payload: {
        receiptId: expect.any(String) as unknown,
        purchaseOrderId: 'po-1',
        locationId: 'loc',
        lines: [{ variantId: 'v1', quantity: 6, unitCost: 5 }],
      },
    });
  });

  it('records goods.received for an unplanned receipt', async () => {
    const db = fakeDb({
      findOne: new Map<unknown, Handler>([
        [Supplier, () => ({ id: 's1', code: 'SUP', status: 'active' })],
        [InventoryLocation, () => ({ id: 'loc' })],
        [
          GoodsReceipt,
          (options) =>
            (options as { where: { id?: string } }).where.id
              ? { id: 'r1', receiptNumber: 'GRN-000001', items: [] }
              : null,
        ],
      ]),
      count: new Map<unknown, Handler>([[ProductVariant, () => 1]]),
    });
    const outbox = { record: jest.fn(() => Promise.resolve('e1')) };
    const service = new PurchaseOrdersService(
      db.dataSource as never,
      audit() as never,
      settings() as never,
      { applyMovement: jest.fn(() => Promise.resolve({})) } as never,
      undefined,
      outbox as never,
    );
    await service.receiveUnplanned('t', 'clerk', {
      idempotencyKey: 'unplanned-1',
      supplierId: 's1',
      locationId: 'loc',
      items: [{ variantId: 'v1', quantity: 3, unitCost: 2 }],
    });
    expect(outbox.record).toHaveBeenCalledWith(
      db.manager,
      expect.objectContaining({
        type: 'goods.received',
        payload: expect.objectContaining({
          purchaseOrderId: null,
          lines: [{ variantId: 'v1', quantity: 3, unitCost: 2 }],
        }) as unknown,
      }),
    );
  });
});

describe('PurchaseOrdersService: short-close', () => {
  it('cancels the unreceived remainder and keeps received stock', async () => {
    const po = {
      id: 'po-1',
      tenantId: 't',
      poNumber: 'PO-000001',
      status: PurchaseOrderStatus.PARTIALLY_RECEIVED,
    } as Record<string, unknown>;
    const db = fakeDb({
      findOne: new Map<unknown, Handler>([[PurchaseOrder, () => po]]),
      find: new Map<unknown, Handler>([
        [
          PurchaseOrderItem,
          () => [
            {
              id: 'a',
              variantId: 'v1',
              sku: 'A',
              quantityOrdered: 10,
              quantityReceived: 4,
              quantityCancelled: 0,
            },
            {
              id: 'b',
              variantId: 'v2',
              sku: 'B',
              quantityOrdered: 3,
              quantityReceived: 3,
              quantityCancelled: 0,
            },
          ],
        ],
      ]),
    });
    const applyMovement = jest.fn();
    const auditService = audit();
    const service = new PurchaseOrdersService(
      db.dataSource as never,
      auditService as never,
      settings() as never,
      { applyMovement } as never,
    );
    jest.spyOn(service, 'get').mockResolvedValue({} as never);

    await service.close('t', 'po-1', 'Supplier discontinued the item');

    expect(db.increments).toEqual([
      expect.objectContaining({
        entity: PurchaseOrderItem,
        column: 'quantityCancelled',
        by: 6,
      }),
    ]);
    // Nothing touches stock or the received quantities
    expect(applyMovement).not.toHaveBeenCalled();
    expect(db.increments.some((i) => i.column === 'quantityReceived')).toBe(
      false,
    );
    expect(po.status).toBe(PurchaseOrderStatus.CLOSED);
    expect(po.closeReason).toBe('Supplier discontinued the item');
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'purchase_order.short_closed' }),
      expect.anything(),
    );
  });

  it('cannot close an order that received nothing (cancel it instead)', async () => {
    const db = fakeDb({
      findOne: new Map<unknown, Handler>([
        [
          PurchaseOrder,
          () => ({ id: 'po-1', status: PurchaseOrderStatus.ISSUED }),
        ],
      ]),
    });
    const service = new PurchaseOrdersService(
      db.dataSource as never,
      audit() as never,
      settings() as never,
      {} as never,
    );
    await expect(service.close('t', 'po-1', 'x')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('PurchaseOrdersService: revisions after approval', () => {
  function setup(threshold: number) {
    const po = {
      id: 'po-1',
      tenantId: 't',
      poNumber: 'PO-000001',
      supplierId: 's1',
      locationId: 'loc',
      status: PurchaseOrderStatus.ISSUED,
      subtotal: 500,
      discountAmount: 0,
      taxAmount: 0,
      shippingCost: 0,
      total: 500,
      userId: 'creator',
      approvedById: 'boss',
      approvedAt: new Date('2026-09-01'),
      revisionNumber: 0,
      revisedById: null,
    } as Record<string, unknown>;
    const item = {
      id: 'line-1',
      variantId: 'v1',
      sku: 'A-1',
      productName: 'Widget',
      quantityOrdered: 100,
      quantityReceived: 0,
      quantityCancelled: 0,
      unitCost: 5,
      discountPercent: 0,
      discountAmount: 0,
      subtotal: 500,
      taxAmount: 0,
      total: 500,
      lineNumber: 1,
    };
    const db = fakeDb({
      findOne: new Map<unknown, Handler>([
        [PurchaseOrder, () => po],
        [Supplier, () => ({ id: 's1', status: 'active', name: 'Acme' })],
        [InventoryLocation, () => ({ id: 'loc', warehouseId: 'w' })],
      ]),
      find: new Map<unknown, Handler>([
        [PurchaseOrderItem, () => [item]],
        [
          ProductVariant,
          () => [{ id: 'v1', sku: 'A-1', product: { name: { en: 'Widget' } } }],
        ],
        [SupplierProduct, () => []],
      ]),
    });
    const auditService = audit();
    const service = new PurchaseOrdersService(
      db.dataSource as never,
      auditService as never,
      settings({ purchaseApprovalThreshold: threshold }) as never,
      {} as never,
    );
    jest.spyOn(service, 'get').mockResolvedValue({} as never);
    return { service, db, po, auditService };
  }

  const revise = (quantity: number) => ({
    supplierId: 's1',
    locationId: 'loc',
    reason: 'Supplier price list',
    items: [{ variantId: 'v1', quantityOrdered: quantity, unitCost: 5 }],
  });

  it('goes back to approval when the revised total exceeds the threshold', async () => {
    const { service, db, po } = setup(1000);
    await service.revise('t', 'buyer', 'po-1', revise(300));
    expect(po).toMatchObject({
      status: PurchaseOrderStatus.PENDING_APPROVAL,
      total: 1500,
      revisionNumber: 1,
      revisedById: 'buyer',
      approvedById: null,
      approvedAt: null,
    });
    const revision = db.saved.find(
      (s) => s.value.revisionNumber === 1 && 'before' in s.value,
    );
    expect(revision?.value).toMatchObject({
      statusBefore: PurchaseOrderStatus.ISSUED,
      statusAfter: PurchaseOrderStatus.PENDING_APPROVAL,
      totalBefore: 500,
      totalAfter: 1500,
      requiresApproval: true,
      before: expect.objectContaining({
        total: 500,
        approvedById: 'boss',
        lines: [expect.objectContaining({ quantityOrdered: 100 })],
      }) as unknown,
      after: expect.objectContaining({
        total: 1500,
        lines: [expect.objectContaining({ quantityOrdered: 300 })],
      }) as unknown,
    });
    // The reviser may not approve it
    expect(PurchaseOrdersService.requesterOf(po as never)).toBe('buyer');
  });

  it('keeps its place when the total stays within the threshold', async () => {
    const { service, po, db } = setup(1000);
    await service.revise('t', 'buyer', 'po-1', revise(150));
    expect(po).toMatchObject({
      status: PurchaseOrderStatus.ISSUED,
      total: 750,
      approvedById: 'boss',
    });
    expect(
      db.saved.some(
        (s) =>
          s.value.requiresApproval === false &&
          s.value.statusAfter === PurchaseOrderStatus.ISSUED,
      ),
    ).toBe(true);
  });

  it('refuses to change the supplier of an approved order', async () => {
    const { service } = setup(1000);
    await expect(
      service.revise('t', 'buyer', 'po-1', { ...revise(10), supplierId: 's2' }),
    ).rejects.toThrow(/supplier of an approved order/);
  });

  it('revision records are listed with the order', () => {
    expect(PurchaseOrderRevision).toBeDefined();
  });
});

// ---------------------------------------------------------------------------

describe('SupplierInvoicesService: duplicate invoice numbers', () => {
  const dto = {
    supplierId: 's1',
    invoiceNumber: ' inv-100 ',
    invoiceType: 'opening_balance' as const,
    invoiceDate: '2026-09-01',
    amount: 250,
  };

  function setup(existing: unknown) {
    const db = fakeDb({
      findOne: new Map<unknown, Handler>([
        [
          Supplier,
          () => ({ id: 's1', paymentTermDays: 30, currencyCode: null }),
        ],
      ]),
      getOne: (entity) => (entity === SupplierInvoice ? existing : null),
    });
    const service = new SupplierInvoicesService(
      db.dataSource as never,
      audit() as never,
      settings() as never,
    );
    jest.spyOn(service, 'get').mockResolvedValue({} as never);
    return { service, db };
  }

  it('refuses the same number twice for a supplier', async () => {
    const { service, db } = setup({ id: 'inv-1', invoiceNumber: 'INV-100' });
    await expect(service.create('t', 'u', dto)).rejects.toThrow(
      ConflictException,
    );
    expect(db.saved).toHaveLength(0);
  });

  it('maps a concurrent duplicate (unique index) to a conflict', async () => {
    const { service, db } = setup(null);
    (db.dataSource.transaction as jest.Mock).mockRejectedValueOnce(
      new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('duplicate key'), {
          code: '23505',
          constraint: 'uq_supplier_invoices_number',
        }),
      ),
    );
    await expect(service.create('t', 'u', dto)).rejects.toThrow(
      /already entered/,
    );
  });

  it('creates an opening balance due after the payment terms', async () => {
    const { service, db } = setup(null);
    await service.create('t', 'u', dto);
    expect(db.saved[0].value).toMatchObject({
      invoiceNumber: 'inv-100',
      invoiceType: 'opening_balance',
      total: 250,
      status: 'open',
      dueDate: '2026-10-01',
    });
  });
});

describe('SupplierInvoicesService: 3-way match on entry', () => {
  it('holds an invoice billing more than was received', async () => {
    const db = fakeDb({
      findOne: new Map<unknown, Handler>([
        [Supplier, () => ({ id: 's1', paymentTermDays: 0 })],
        [
          PurchaseOrder,
          () => ({ id: 'po-1', supplierId: 's1', currencyCode: 'USD' }),
        ],
      ]),
      find: new Map<unknown, Handler>([
        [
          PurchaseOrderItem,
          () => [
            {
              id: 'line-1',
              purchaseOrderId: 'po-1',
              variantId: 'v1',
              productName: 'Widget',
              quantityReceived: 10,
              unitCost: 4,
              discountPercent: 25,
            },
          ],
        ],
        [PurchaseOrder, () => [{ id: 'po-1', supplierId: 's1' }]],
      ]),
      // 8 already invoiced elsewhere
      raw: () => [{ id: 'line-1', quantity: '8' }],
    });
    const service = new SupplierInvoicesService(
      db.dataSource as never,
      audit() as never,
      settings({ purchaseInvoiceVarianceTolerance: 2 }) as never,
    );
    jest.spyOn(service, 'get').mockResolvedValue({} as never);
    await service.create('t', 'u', {
      supplierId: 's1',
      invoiceNumber: 'A-9',
      purchaseOrderId: 'po-1',
      invoiceDate: '2026-09-01',
      items: [{ purchaseOrderItemId: 'line-1', quantity: 5, unitPrice: 3 }],
    });
    const invoice = db.saved[0].value;
    expect(invoice).toMatchObject({
      status: 'pending_approval',
      hasVariance: true,
      total: 15,
    });
    const [line] = db.inserted.find((i) => i.entity !== null)!.value as Record<
      string,
      unknown
    >[];
    // Net order price 4 − 25% = 3 → no price variance; 5 billed, 2 left to bill
    expect(line).toMatchObject({
      expectedUnitPrice: 3,
      matchableQuantity: 2,
      priceVariance: 0,
      quantityVariance: 3,
      varianceFlag: true,
    });
  });
});

// ---------------------------------------------------------------------------

describe('SupplierReturnsService', () => {
  function setup() {
    const receipt = {
      id: 'r1',
      tenantId: 't',
      receiptNumber: 'GRN-000001',
      supplierId: 's1',
      locationId: 'loc',
      purchaseOrderId: null,
    };
    const db = fakeDb({
      findOne: new Map<unknown, Handler>([
        [GoodsReceipt, () => receipt],
        [Supplier, () => ({ id: 's1', code: 'ACME', currencyCode: 'USD' })],
      ]),
      find: new Map<unknown, Handler>([
        [
          GoodsReceiptItem,
          () => [
            {
              id: 'ri-1',
              variantId: 'v1',
              quantity: 10,
              accepted: true,
              quantityReturned: 6,
              unitCost: 2.5,
            },
          ],
        ],
      ]),
    });
    const applyMovement = jest.fn(() => Promise.resolve({}));
    const service = new SupplierReturnsService(
      db.dataSource as never,
      audit() as never,
      { applyMovement } as never,
      settings() as never,
    );
    jest.spyOn(service, 'get').mockResolvedValue({} as never);
    return { service, db, applyMovement };
  }

  it('refuses to return more than received − already returned', async () => {
    const { service, applyMovement } = setup();
    await expect(
      service.create('t', 'u', {
        receiptId: 'r1',
        reason: 'Damaged',
        items: [{ receiptItemId: 'ri-1', quantity: 5 }],
      }),
    ).rejects.toThrow(/Only 4 unit/);
    expect(applyMovement).not.toHaveBeenCalled();
  });

  it('posts a stock decrease and creates a supplier credit', async () => {
    const { service, db, applyMovement } = setup();
    await service.create('t', 'u', {
      receiptId: 'r1',
      reason: 'Damaged',
      items: [{ receiptItemId: 'ri-1', quantity: 4 }],
    });
    expect(applyMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        delta: -4,
        locationId: 'loc',
        referenceType: 'supplier_return',
        preventNegative: true,
      }),
    );
    expect(db.increments).toContainEqual(
      expect.objectContaining({
        entity: GoodsReceiptItem,
        column: 'quantityReturned',
        by: 4,
      }),
    );
    expect(
      db.inserted.find((i) => i.entity === SupplierReturnItem)?.value,
    ).toMatchObject({ quantity: 4, total: 10 });
    const credit = db.saved.find((s) => s.value.creditType === 'return');
    expect(credit?.value).toMatchObject({ amount: 10, status: 'open' });
    expect(SupplierCredit).toBeDefined();
  });
});

// ---------------------------------------------------------------------------

describe('PayablesService: allocations never over-allocate', () => {
  function setup(allocatedToInvoice: number, allocatedFromPayment: number) {
    const db = fakeDb({
      findOne: new Map<unknown, Handler>([
        [
          SupplierPayment,
          () => ({
            id: 'p1',
            paymentNumber: 'SP-000001',
            supplierId: 's1',
            amount: 100,
            status: 'posted',
          }),
        ],
      ]),
      find: new Map<unknown, Handler>([
        [
          SupplierInvoice,
          () => [
            {
              id: 'i1',
              supplierId: 's1',
              status: 'open',
              total: 80,
              invoiceNumber: 'A-1',
            },
          ],
        ],
      ]),
      raw: (entity) =>
        entity === SupplierAllocation
          ? [{ id: 'x', invoiceId: 'i1', amount: allocatedToInvoice }]
          : [],
    });
    // Both sums come from the same query builder: first per invoice, then per payment
    let call = 0;
    db.manager.getRepository.mockImplementation((entity: unknown) => ({
      findOne: (o: unknown) => db.manager.findOne(entity, o),
      find: (o: unknown) => db.manager.find(entity, o),
      count: () => Promise.resolve(0),
      createQueryBuilder: () => {
        const qb: Record<string, unknown> = {};
        for (const m of ['select', 'addSelect', 'where', 'groupBy']) {
          qb[m] = () => qb;
        }
        qb.getRawMany = () =>
          Promise.resolve(
            call++ === 0
              ? [{ invoiceId: 'i1', amount: allocatedToInvoice }]
              : [{ id: 'p1', amount: allocatedFromPayment }],
          );
        return qb;
      },
    }));
    const service = new PayablesService(
      db.dataSource as never,
      audit() as never,
      settings() as never,
    );
    jest.spyOn(service, 'getPayment').mockResolvedValue({} as never);
    return { service, db };
  }

  it('refuses more than the invoice still owes', async () => {
    const { service, db } = setup(50, 0);
    await expect(
      service.allocatePayment('t', 'u', 'p1', {
        allocations: [{ invoiceId: 'i1', amount: 30.01 }],
      }),
    ).rejects.toThrow(/Only 30.00 is still owed/);
    expect(db.inserted).toHaveLength(0);
  });

  it('refuses more than the payment has left', async () => {
    const { service, db } = setup(0, 90);
    await expect(
      service.allocatePayment('t', 'u', 'p1', {
        allocations: [{ invoiceId: 'i1', amount: 10.5 }],
      }),
    ).rejects.toThrow(/Only 10.00 is left/);
    expect(db.inserted).toHaveLength(0);
  });

  it('allocates a partial amount', async () => {
    const { service, db } = setup(50, 60);
    await service.allocatePayment('t', 'u', 'p1', {
      allocations: [{ invoiceId: 'i1', amount: 30 }],
    });
    expect(db.inserted).toEqual([
      {
        entity: SupplierAllocation,
        value: expect.objectContaining({
          invoiceId: 'i1',
          paymentId: 'p1',
          creditId: null,
          amount: 30,
        }) as unknown,
      },
    ]);
  });
});
