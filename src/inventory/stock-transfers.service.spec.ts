import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import {
  APPROVABLE_KEY,
  PERMISSIONS_KEY,
} from '../auth/decorators/permissions.decorator';
import {
  StockTransfer,
  StockTransferStatus,
} from '../database/entities/stock-transfer.entity';
import { StockTransferItem } from '../database/entities/stock-transfer-item.entity';
import { StockTransferEvent } from '../database/entities/stock-transfer-event.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import {
  MovementType,
  StockMovement,
} from '../database/entities/stock-movement.entity';
import { SettingsService } from '../settings/settings.service';
import { InventoryService, MovementInput } from './inventory.service';
import { StockTransfersController } from './stock-transfers.controller';
import { StockTransfersService } from './stock-transfers.service';

const TENANT = 'tenant-1';
const SOURCE = 'loc-a';
const DEST = 'loc-b';
const TRANSIT = 'loc-transit';
const QUARANTINE = 'loc-quarantine';

/**
 * In-memory ledger standing in for InventoryService: per (variant, location)
 * balances that refuse to go below zero (D018), source-key idempotency, and
 * the destination's in-transit counter.
 */
function fakeLedger(options: { quarantine?: boolean } = {}) {
  const balances = new Map<string, number>();
  const inTransitCounter = new Map<string, number>();
  const movements: {
    variantId: string;
    locationId: string;
    delta: number;
    movementType: MovementType;
    sourceKey?: string | null;
    allowOversell?: boolean;
  }[] = [];
  const key = (variantId: string, locationId: string) =>
    `${variantId}@${locationId}`;

  const applyMovement = jest.fn(
    (_manager: EntityManager, input: MovementInput) => {
      if (
        input.sourceKey &&
        movements.some((m) => m.sourceKey === input.sourceKey)
      ) {
        return Promise.resolve({ unitCost: 4, duplicate: true });
      }
      const k = key(input.variantId, input.locationId);
      const balance = balances.get(k) ?? 0;
      if (
        input.delta < 0 &&
        !input.allowOversell &&
        balance + input.delta < 0
      ) {
        return Promise.reject(
          new BadRequestException(`Not enough stock (${balance} available)`),
        );
      }
      balances.set(k, balance + input.delta);
      movements.push({
        variantId: input.variantId,
        locationId: input.locationId,
        delta: input.delta,
        movementType: input.movementType,
        sourceKey: input.sourceKey,
        allowOversell: input.allowOversell,
      });
      return Promise.resolve({
        quantityOnHand: balance + input.delta,
        unitCost: input.cost ?? 4,
      });
    },
  );
  const inventory = {
    applyMovement,
    moveBetween: jest.fn(
      async (
        manager: EntityManager,
        input: Omit<MovementInput, 'locationId' | 'delta'> & {
          fromLocationId: string;
          toLocationId: string;
          quantity: number;
        },
      ) => {
        const { fromLocationId, toLocationId, quantity, ...rest } = input;
        const out = await applyMovement(manager, {
          ...rest,
          locationId: fromLocationId,
          delta: -quantity,
          sourceKey: rest.sourceKey ? `${rest.sourceKey}:out` : null,
        });
        const inbound = await applyMovement(manager, {
          ...rest,
          locationId: toLocationId,
          delta: quantity,
          sourceKey: rest.sourceKey ? `${rest.sourceKey}:in` : null,
        });
        return { out, in: inbound };
      },
    ),
    adjustInTransit: jest.fn(
      (
        _manager: EntityManager,
        input: { variantId: string; locationId: string; delta: number },
      ) => {
        const k = key(input.variantId, input.locationId);
        inTransitCounter.set(k, (inTransitCounter.get(k) ?? 0) + input.delta);
        return Promise.resolve();
      },
    ),
    transitLocationId: jest.fn(() => Promise.resolve(TRANSIT)),
    resolveConditionLocation: jest.fn(
      (_m: EntityManager, _t: string, locationId: string, condition: string) =>
        Promise.resolve(
          condition === 'damaged' && options.quarantine
            ? QUARANTINE
            : locationId,
        ),
    ),
  };
  const balance = (locationId: string, variantId = 'var-1') =>
    balances.get(key(variantId, locationId)) ?? 0;
  return {
    inventory,
    balances,
    movements,
    balance,
    inTransit: (variantId = 'var-1') =>
      inTransitCounter.get(key(variantId, DEST)) ?? 0,
    seed: (locationId: string, quantity: number, variantId = 'var-1') =>
      balances.set(key(variantId, locationId), quantity),
  };
}

function setup(
  options: {
    quarantine?: boolean;
    settings?: Record<string, unknown>;
    transfer?: Partial<StockTransfer>;
    items?: Partial<StockTransferItem>[];
  } = {},
) {
  const ledger = fakeLedger({ quarantine: options.quarantine });
  const transfer: Partial<StockTransfer> = {
    id: 'trf-1',
    tenantId: TENANT,
    transferNumber: 'TRF-0001',
    fromLocationId: SOURCE,
    toLocationId: DEST,
    status: StockTransferStatus.APPROVED,
    transitLedger: true,
    transitLocationId: null,
    dispatchComplete: false,
    dispatchedAt: null,
    createdById: 'user-1',
    requestedById: 'user-1',
    ...options.transfer,
  };
  const items: Partial<StockTransferItem>[] = options.items ?? [
    {
      id: 'item-1',
      tenantId: TENANT,
      variantId: 'var-1',
      quantityRequested: 10,
      quantityDispatched: 0,
      quantityReceived: 0,
      quantityWrittenOff: 0,
      quantityDamaged: 0,
      quantityMissing: 0,
      quantityReturned: 0,
      quantityOverReceived: 0,
      unitCost: null,
    },
  ];
  const events: Partial<StockTransferEvent>[] = [];
  const created: { entity: unknown; data: Record<string, unknown> }[] = [];
  const manager = {
    findOne: jest.fn(
      (entity: unknown, options: { where: Record<string, unknown> }) => {
        if (entity === StockTransfer) return Promise.resolve(transfer);
        if (entity === StockTransferEvent) {
          return Promise.resolve(
            events.find(
              (e) =>
                e.kind === options.where.kind &&
                e.idempotencyKey === options.where.idempotencyKey,
            ) ?? null,
          );
        }
        return Promise.resolve(null);
      },
    ),
    find: jest.fn((entity: unknown) =>
      Promise.resolve(
        entity === ProductVariant
          ? [{ id: 'var-1', cost: 4 }]
          : entity === StockTransferItem
            ? items
            : [],
      ),
    ),
    create: jest.fn((entity: unknown, data: Record<string, unknown>) => {
      created.push({ entity, data });
      return { ...data };
    }),
    save: jest.fn((data: Record<string, unknown>) => {
      if ('kind' in data && !data.id) {
        data.id = `evt-${events.length + 1}`;
        events.push(data);
      }
      return Promise.resolve(data);
    }),
    update: jest.fn(
      (entity: unknown, where: { id?: string }, patch: object) => {
        if (entity === StockTransferItem) {
          Object.assign(items.find((i) => i.id === where.id) ?? {}, patch);
        }
        return Promise.resolve();
      },
    ),
  };
  const dataSource = {
    transaction: jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager),
    ),
  };
  const settings = {
    getSettings: jest.fn(() =>
      Promise.resolve({
        transferApprovalMode: 'never',
        transferApprovalThreshold: 0,
        transferOverReceiptTolerancePercent: 0,
        ...options.settings,
      }),
    ),
  };
  const audit = { record: jest.fn() };
  const service = new StockTransfersService(
    dataSource as unknown as DataSource,
    ledger.inventory as unknown as InventoryService,
    audit as unknown as AuditService,
    settings as unknown as SettingsService,
  );
  jest
    .spyOn(service, 'get')
    .mockImplementation(() => Promise.resolve(transfer as never));
  return { service, ledger, transfer, items, events, created, audit, manager };
}

describe('StockTransfersService: conservation through the transit location', () => {
  it('moves source → transit → destination / quarantine / write-off, and the ledger adds up', async () => {
    const { service, ledger, transfer, items } = setup({ quarantine: true });
    ledger.seed(SOURCE, 10);

    // Two dispatches
    await service.dispatch(TENANT, 'trf-1', 'user-1', {
      items: [{ itemId: 'item-1', quantity: 4 }],
    });
    expect(transfer.status).toBe(StockTransferStatus.PARTIALLY_DISPATCHED);
    expect(ledger.balance(SOURCE)).toBe(6);
    expect(ledger.balance(TRANSIT)).toBe(4);
    await service.dispatch(TENANT, 'trf-1', 'user-1', {});
    expect(transfer.status).toBe(StockTransferStatus.IN_TRANSIT);
    expect(transfer.transitLocationId).toBe(TRANSIT);
    expect(ledger.balance(SOURCE)).toBe(0);
    expect(ledger.balance(TRANSIT)).toBe(10);
    expect(ledger.inTransit()).toBe(10);

    // 6 good, 2 damaged (to quarantine), 2 reported missing
    await service.receive(TENANT, 'trf-1', 'user-2', {
      items: [{ itemId: 'item-1', quantity: 6, damaged: 2, missing: 2 }],
    });
    expect(ledger.balance(DEST)).toBe(6);
    expect(ledger.balance(QUARANTINE)).toBe(2);
    expect(ledger.balance(TRANSIT)).toBe(2);
    expect(items[0]).toMatchObject({
      quantityDispatched: 10,
      quantityReceived: 6,
      quantityDamaged: 2,
      quantityMissing: 2,
    });
    expect(transfer.status).toBe(StockTransferStatus.PARTIALLY_RECEIVED);

    // The missing ones never turn up
    await service.writeOff(TENANT, 'trf-1', 'user-2', {
      reason: 'Lost by the courier',
    });
    expect(ledger.balance(TRANSIT)).toBe(0);
    expect(ledger.inTransit()).toBe(0);
    expect(transfer.status).toBe(StockTransferStatus.RECEIVED);

    // Conservation: every unit that left the source is somewhere or written off
    const net = (locationId: string) =>
      ledger.movements
        .filter((m) => m.locationId === locationId)
        .reduce((sum, m) => sum + m.delta, 0);
    expect(net(SOURCE)).toBe(-10);
    expect(net(DEST) + net(QUARANTINE) + net(TRANSIT)).toBe(8);
    const writtenOff = ledger.movements
      .filter(
        (m) =>
          m.locationId === TRANSIT &&
          m.movementType === MovementType.ADJUSTMENT,
      )
      .reduce((sum, m) => sum - m.delta, 0);
    expect(writtenOff).toBe(2);
    // Every movement carries its event's source key; none oversold
    expect(ledger.movements.every((m) => !!m.sourceKey)).toBe(true);
    expect(ledger.movements.some((m) => m.allowOversell)).toBe(false);
  });

  it('D018: refuses to dispatch more than the source has', async () => {
    const { service, ledger, items } = setup();
    ledger.seed(SOURCE, 3);
    await expect(
      service.dispatch(TENANT, 'trf-1', 'user-1', {
        items: [{ itemId: 'item-1', quantity: 5 }],
      }),
    ).rejects.toThrow('Not enough stock (3 available)');
    expect(ledger.balance(SOURCE)).toBe(3);
    expect(items[0].quantityDispatched).toBe(0);
  });

  it('a retried dispatch with the same idempotency key posts nothing twice', async () => {
    const { service, ledger } = setup();
    ledger.seed(SOURCE, 10);
    const dto = {
      items: [{ itemId: 'item-1', quantity: 4 }],
      idempotencyKey: 'k-1',
    };
    await service.dispatch(TENANT, 'trf-1', 'user-1', dto);
    await service.dispatch(TENANT, 'trf-1', 'user-1', dto);
    expect(ledger.balance(SOURCE)).toBe(6);
    expect(ledger.balance(TRANSIT)).toBe(4);
  });

  it('damaged goods are a loss out of transit when the destination has no quarantine location', async () => {
    const { service, ledger } = setup({ quarantine: false });
    ledger.seed(SOURCE, 5);
    await service.dispatch(TENANT, 'trf-1', 'user-1', {
      items: [{ itemId: 'item-1', quantity: 5 }],
      complete: true,
    });
    await service.receive(TENANT, 'trf-1', 'user-2', {
      items: [{ itemId: 'item-1', quantity: 4, damaged: 1 }],
    });
    expect(ledger.balance(DEST)).toBe(4);
    expect(ledger.balance(TRANSIT)).toBe(0);
    expect(ledger.movements).toContainEqual(
      expect.objectContaining({
        locationId: TRANSIT,
        delta: -1,
        movementType: MovementType.DAMAGE,
      }),
    );
  });

  it('cancelling after dispatch returns what is in transit to the source', async () => {
    const { service, ledger, transfer, items } = setup();
    ledger.seed(SOURCE, 10);
    await service.dispatch(TENANT, 'trf-1', 'user-1', {});
    await service.receive(TENANT, 'trf-1', 'user-2', {
      items: [{ itemId: 'item-1', quantity: 3 }],
    });
    await service.cancel(TENANT, 'trf-1', 'user-1', 'Wrong store');
    expect(transfer.status).toBe(StockTransferStatus.CANCELLED);
    expect(items[0].quantityReturned).toBe(7);
    expect(ledger.balance(SOURCE)).toBe(7);
    expect(ledger.balance(DEST)).toBe(3);
    expect(ledger.balance(TRANSIT)).toBe(0);
    expect(ledger.inTransit()).toBe(0);
  });
});

describe('StockTransfersService: approval and over-receipt', () => {
  it('asks for approval above the threshold and never lets the requester approve', async () => {
    const { service, transfer } = setup({
      transfer: { status: StockTransferStatus.DRAFT, requestedById: null },
      settings: {
        transferApprovalMode: 'threshold',
        transferApprovalThreshold: 30,
      },
    });
    // 10 units × cost 4 = 40 > 30: can't be dispatched straight from draft
    await expect(
      service.dispatch(TENANT, 'trf-1', 'user-1', {}),
    ).rejects.toThrow('needs approval');
    await service.request(TENANT, 'trf-1', 'user-1');
    expect(transfer).toMatchObject({
      status: StockTransferStatus.REQUESTED,
      approvalRequired: true,
      requestedById: 'user-1',
    });
    await expect(service.approve(TENANT, 'trf-1', 'user-1')).rejects.toThrow(
      'someone other than the requester',
    );
    await service.approve(TENANT, 'trf-1', 'manager-1');
    expect(transfer).toMatchObject({
      status: StockTransferStatus.APPROVED,
      approvedById: 'manager-1',
    });
  });

  it('is approved at once when the setting does not ask for approval', async () => {
    const { service, transfer } = setup({
      transfer: { status: StockTransferStatus.DRAFT },
    });
    await service.request(TENANT, 'trf-1', 'user-1');
    expect(transfer.status).toBe(StockTransferStatus.APPROVED);
    expect(transfer.approvalRequired).toBe(false);
  });

  it('needs an approver for an over-receipt above the tolerance', async () => {
    const { service, ledger, items } = setup({
      settings: { transferOverReceiptTolerancePercent: 10 },
    });
    ledger.seed(SOURCE, 12);
    await service.dispatch(TENANT, 'trf-1', 'user-1', {});
    // 12 arrive for 10 sent: 2 over, 1 allowed
    const dto = { items: [{ itemId: 'item-1', quantity: 12 }] };
    await expect(
      service.receive(TENANT, 'trf-1', 'user-2', dto),
    ).rejects.toThrow(ForbiddenException);
    await service.receive(TENANT, 'trf-1', 'user-2', dto, 'manager-1');
    // The extra units came out of the source too
    expect(ledger.balance(SOURCE)).toBe(0);
    expect(ledger.balance(DEST)).toBe(12);
    expect(items[0]).toMatchObject({
      quantityDispatched: 12,
      quantityOverReceived: 2,
      quantityReceived: 12,
    });
  });
});

describe('StockTransfersService.writeOff (legacy transfer without transit ledger)', () => {
  it('posts a location-less loss movement referencing the transfer', async () => {
    const { service, ledger, created, transfer } = setup({
      transfer: {
        status: StockTransferStatus.IN_TRANSIT,
        transitLedger: false,
        dispatchComplete: true,
      },
      items: [
        {
          id: 'item-1',
          tenantId: TENANT,
          variantId: 'var-1',
          quantityRequested: 10,
          quantityDispatched: 10,
          quantityReceived: 7,
          quantityWrittenOff: 0,
          unitCost: 4,
        },
      ],
    });
    await service.writeOff(TENANT, 'trf-1', 'user-1', {
      reason: '  Box lost by the courier ',
    });
    const movements = created
      .filter((c) => c.entity === StockMovement)
      .map((c) => c.data);
    expect(movements).toEqual([
      expect.objectContaining({
        variantId: 'var-1',
        movementType: MovementType.ADJUSTMENT,
        quantity: 3,
        referenceId: 'trf-1',
        cost: 4,
        notes: 'Box lost by the courier',
        metadata: expect.objectContaining({
          kind: 'transfer_write_off',
          transferItemId: 'item-1',
        }) as unknown,
      }),
    ]);
    expect(movements[0].fromLocationId).toBeUndefined();
    expect(ledger.inventory.applyMovement).not.toHaveBeenCalled();
    expect(ledger.inTransit()).toBe(-3);
    expect(transfer.status).toBe(StockTransferStatus.RECEIVED);
  });

  it('requires a reason', async () => {
    const { service, manager } = setup();
    await expect(
      service.writeOff(TENANT, 'trf-1', 'user-1', { reason: '  ' }),
    ).rejects.toThrow(BadRequestException);
    expect(manager.findOne).not.toHaveBeenCalled();
  });
});

describe('StockTransfersController permissions', () => {
  const reflector = new Reflector();
  const meta = (name: keyof StockTransfersController) =>
    Object.getOwnPropertyDescriptor(StockTransfersController.prototype, name)!
      .value as () => unknown;

  it('write-off needs inventory.adjust on top of inventory.transfer, or a manager approval', () => {
    expect(reflector.get(PERMISSIONS_KEY, meta('writeOff'))).toEqual([
      'inventory.transfer',
      'inventory.adjust',
    ]);
    expect(reflector.get(APPROVABLE_KEY, meta('writeOff'))).toBe(true);
  });

  it('approval needs inventory.transfer.approve (or a manager approval)', () => {
    expect(reflector.get(PERMISSIONS_KEY, meta('approve'))).toEqual([
      'inventory.transfer.approve',
    ]);
    expect(reflector.get(APPROVABLE_KEY, meta('approve'))).toBe(true);
    expect(reflector.get(PERMISSIONS_KEY, meta('reject'))).toEqual([
      'inventory.transfer.approve',
    ]);
  });

  it('resolves the transfer service through Nest', async () => {
    const module = await Test.createTestingModule({
      providers: [
        StockTransfersService,
        { provide: DataSource, useValue: {} },
        { provide: InventoryService, useValue: {} },
        { provide: AuditService, useValue: {} },
        { provide: SettingsService, useValue: {} },
      ],
    }).compile();
    expect(module.get(StockTransfersService)).toBeInstanceOf(
      StockTransfersService,
    );
  });
});
