import { BadRequestException, ConflictException } from '@nestjs/common';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { requestContext } from '../common/context/request-context';
import { EntityManager } from 'typeorm';
import { InventoryService } from './inventory.service';
import { StockLevel } from '../database/entities/stock-level.entity';
import { MovementType } from '../database/entities/stock-movement.entity';
import { ReservationStatus } from '../database/entities/stock-reservation.entity';
import { AdjustmentReason } from '../database/entities/stock-adjustment.entity';
import { SettingsService } from '../settings/settings.service';
import { AuditService } from '../audit/audit.service';

/**
 * applyMovement / reserve / releaseReservations against an in-memory manager:
 * one stock level, one variant, FIFO layers and reservations.
 */
function setup(options: {
  onHand: number;
  reserved?: number;
  cost?: number | null;
  stockQuantity?: number;
  costingMethod?: 'average' | 'fifo';
  layers?: { id: string; quantityRemaining: number; unitCost: number }[];
  // Quantities of active reservations that are past their expiry
  expired?: number[];
  outbox?: { record: jest.Mock };
}) {
  const level = {
    tenantId: 't',
    variantId: 'v',
    locationId: 'l',
    quantityOnHand: options.onHand,
    quantityReserved: options.reserved ?? 0,
    quantityAvailable: options.onHand - (options.reserved ?? 0),
    quantityInTransit: 0,
  } as StockLevel;
  const variant = {
    id: 'v',
    cost: options.cost === undefined ? 2 : options.cost,
    stockQuantity: options.stockQuantity ?? options.onHand,
  };
  let expired = options.expired ?? [];
  const inserted: Record<string, unknown>[] = [];
  const saved: unknown[] = [];
  const layers = options.layers ?? [];
  const closedRows: unknown[] = [];

  const manager = {
    query: jest.fn((sql: string, _params?: unknown[]): Promise<unknown> => {
      void _params;
      if (sql.includes('UPDATE stock_reservations')) {
        const rows = expired.map((quantity) => ({ quantity }));
        expired = [];
        return Promise.resolve([rows, rows.length]);
      }
      return Promise.resolve([]);
    }),
    findOneOrFail: jest.fn(() => Promise.resolve(level)),
    findOne: jest.fn(() => Promise.resolve(variant)),
    find: jest.fn(() =>
      Promise.resolve([
        { variantId: 'v', locationId: 'l', quantity: 3 },
        { variantId: 'v', locationId: 'l', quantity: 2 },
      ]),
    ),
    save: jest.fn((entity: unknown) => {
      saved.push(entity);
      return Promise.resolve(entity);
    }),
    create: jest.fn((_: unknown, data: object) => ({ ...data })),
    insert: jest.fn((_: unknown, data: Record<string, unknown>) => {
      inserted.push(data);
      return Promise.resolve();
    }),
    increment: jest.fn(),
    decrement: jest.fn(),
    update: jest.fn(),
    getRepository: jest.fn(() => ({
      createQueryBuilder: () => {
        const qb = {
          where: () => qb,
          andWhere: () => qb,
          orderBy: () => qb,
          addOrderBy: () => qb,
          setLock: () => qb,
          getMany: () => Promise.resolve(layers),
        };
        return qb;
      },
    })),
    createQueryBuilder: jest.fn(() => {
      const qb = {
        update: () => qb,
        set: () => qb,
        where: () => qb,
        andWhere: () => qb,
        returning: () => qb,
        execute: () =>
          Promise.resolve({
            raw: [
              { variantId: 'v', locationId: 'l', quantity: 3 },
              { variantId: 'v', locationId: 'l', quantity: 2 },
            ].map((r) => {
              closedRows.push(r);
              return r;
            }),
          }),
      };
      return qb;
    }),
  };
  const settings = {
    getSettings: jest.fn(() =>
      Promise.resolve({ costingMethod: options.costingMethod ?? 'average' }),
    ),
  };
  const service = new InventoryService(
    {} as never,
    {} as never,
    settings as unknown as SettingsService,
    {} as never,
    { record: jest.fn() } as unknown as AuditService,
    options.outbox as never,
  );
  return {
    service,
    manager,
    em: manager as unknown as EntityManager,
    level,
    variant,
    inserted,
    saved,
  };
}

const sale = (delta: number, preventNegative = true) => ({
  tenantId: 't',
  userId: 'u',
  variantId: 'v',
  locationId: 'l',
  delta,
  movementType: MovementType.SALE,
  preventNegative,
});

describe('InventoryService availability (reservations)', () => {
  it('behaves as before when nothing is reserved', async () => {
    const { service, em, level } = setup({ onHand: 5 });
    await expect(service.applyMovement(em, sale(-6))).rejects.toThrow(
      'Not enough stock (5 available)',
    );
    const result = await service.applyMovement(em, sale(-5));
    expect(result).toBe(level);
    expect(level.quantityOnHand).toBe(0);
    expect(level.quantityAvailable).toBe(0);
  });

  it('checks available = on hand − reserved', async () => {
    const { service, em, level } = setup({ onHand: 10, reserved: 7 });
    await expect(service.applyMovement(em, sale(-4))).rejects.toThrow(
      BadRequestException,
    );
    await service.applyMovement(em, sale(-3));
    expect(level).toMatchObject({
      quantityOnHand: 7,
      quantityReserved: 7,
      quantityAvailable: 0,
    });
  });

  it('D018: refuses to go below zero even without preventNegative', async () => {
    const { service, em, level } = setup({ onHand: 2, reserved: 0 });
    await expect(service.applyMovement(em, sale(-5, false))).rejects.toThrow(
      'Not enough stock (2 available)',
    );
    expect(level.quantityOnHand).toBe(2);
  });

  it('only an explicit allowOversell (offline sale review) goes below zero', async () => {
    const { service, em, level, saved } = setup({ onHand: 2, reserved: 2 });
    await service.applyMovement(em, {
      ...sale(-5, false),
      allowOversell: true,
    });
    expect(level.quantityOnHand).toBe(-3);
    expect(level.quantityAvailable).toBe(-5);
    expect(saved).toContainEqual(
      expect.objectContaining({
        quantity: 5,
        metadata: expect.objectContaining({ oversell: true }) as unknown,
      }),
    );
  });

  it('counts and adjustments ignore reservations but never go below zero on hand', async () => {
    const { service, em, level } = setup({ onHand: 5, reserved: 4 });
    const recount = {
      ...sale(-3),
      movementType: MovementType.RECOUNT,
      respectReservations: false,
    };
    await service.applyMovement(em, recount);
    expect(level.quantityOnHand).toBe(2);
    await expect(
      service.applyMovement(em, { ...recount, delta: -3 }),
    ).rejects.toThrow('Not enough stock (2 on hand)');
  });

  it('releases expired reservations before refusing a sale', async () => {
    const { service, em, level } = setup({
      onHand: 10,
      reserved: 7,
      expired: [4],
    });
    await service.applyMovement(em, sale(-6));
    expect(level).toMatchObject({
      quantityOnHand: 4,
      quantityReserved: 3,
      quantityAvailable: 1,
    });
  });

  it('reserve() holds stock and lowers availability', async () => {
    const { service, em, level, manager } = setup({ onHand: 10 });
    const reservation = await service.reserve(em, {
      tenantId: 't',
      variantId: 'v',
      locationId: 'l',
      quantity: 4,
      referenceType: 'held_cart',
      referenceId: 'cart-1',
      expiresAt: new Date('2030-01-01'),
    });
    expect(reservation).toMatchObject({
      quantity: 4,
      status: ReservationStatus.ACTIVE,
      referenceId: 'cart-1',
    });
    expect(level).toMatchObject({ quantityReserved: 4, quantityAvailable: 6 });
    expect(manager.findOneOrFail).toHaveBeenCalledWith(
      StockLevel,
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
  });

  it('reserve() refuses a shortage unless allowOversell (D018)', async () => {
    const input = {
      tenantId: 't',
      variantId: 'v',
      locationId: 'l',
      quantity: 4,
      referenceType: 'held_cart',
      referenceId: 'c',
    };
    const strict = setup({ onHand: 3 });
    await expect(strict.service.reserve(strict.em, input)).rejects.toThrow(
      'Not enough stock to reserve (3 available)',
    );
    // preventNegative: false no longer opts out
    await expect(
      strict.service.reserve(strict.em, { ...input, preventNegative: false }),
    ).rejects.toThrow('Not enough stock to reserve');
    const lenient = setup({ onHand: 3 });
    await lenient.service.reserve(lenient.em, {
      ...input,
      allowOversell: true,
    });
    expect(lenient.level.quantityAvailable).toBe(-1);
    await expect(
      lenient.service.reserve(lenient.em, { ...input, quantity: 0 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('releaseReservations() gives the quantities back to the level', async () => {
    const { service, em, manager } = setup({ onHand: 10, reserved: 5 });
    const closed = await service.releaseReservations(em, {
      tenantId: 't',
      referenceType: 'held_cart',
      referenceId: 'cart-1',
      status: ReservationStatus.COMMITTED,
    });
    expect(closed).toHaveLength(2);
    const levelUpdate = manager.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE stock_levels'),
    ) as unknown[];
    expect(levelUpdate[1]).toEqual(['t', 'v', 'l', 5]);
  });
});

describe('InventoryService costing', () => {
  it('returns the average cost for an outbound movement', async () => {
    const { service, em } = setup({ onHand: 10, cost: 2.5 });
    const result = await service.applyMovement(em, sale(-2));
    expect(result.unitCost).toBe(2.5);
  });

  it('returns the FIFO cost of the consumed layers', async () => {
    const { service, em, manager } = setup({
      onHand: 15,
      cost: 4,
      costingMethod: 'fifo',
      layers: [
        { id: 'a', quantityRemaining: 5, unitCost: 2 },
        { id: 'b', quantityRemaining: 10, unitCost: 4 },
      ],
    });
    const result = await service.applyMovement(em, sale(-10));
    expect(result.unitCost).toBe(3);
    expect(manager.decrement).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'a' },
      'quantityRemaining',
      5,
    );
  });

  it('updates the moving average on a purchase and adds a layer', async () => {
    const { service, em, manager, inserted } = setup({
      onHand: 10,
      cost: 2,
      stockQuantity: 10,
    });
    const result = await service.applyMovement(em, {
      ...sale(10, false),
      movementType: MovementType.PURCHASE,
      cost: 4,
    });
    expect(result.unitCost).toBe(4);
    expect(manager.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'v', tenantId: 't' },
      { cost: 3 },
    );
    expect(inserted).toContainEqual(
      expect.objectContaining({ quantityRemaining: 10, unitCost: 4 }),
    );
  });

  it('values a return at the current cost without moving the average', async () => {
    const { service, em, manager, inserted } = setup({ onHand: 1, cost: 2 });
    const result = await service.applyMovement(em, {
      ...sale(3, false),
      movementType: MovementType.RETURN,
    });
    expect(result.unitCost).toBe(2);
    expect(manager.update).not.toHaveBeenCalled();
    expect(inserted).toContainEqual(
      expect.objectContaining({ quantityRemaining: 3, unitCost: 2 }),
    );
  });
});

describe('InventoryService ledger integrity', () => {
  const posted = (saved: unknown[]) =>
    saved.filter(
      (row): row is Record<string, unknown> =>
        typeof row === 'object' &&
        row !== null &&
        'movementType' in row &&
        'quantity' in row,
    );

  it('stores a default source key from the reference, variant, location and type', async () => {
    const { service, em, saved } = setup({ onHand: 10 });
    await service.applyMovement(em, {
      ...sale(-2),
      referenceType: 'sale',
      referenceId: 's-1',
    });
    expect(posted(saved)[0]).toMatchObject({
      sourceEventId: 'sale:s-1:v:l:sale',
      quantity: 2,
    });
  });

  it('numbers repeats of a default key inside one transaction (two lines, same variant)', async () => {
    const { service, em, saved } = setup({ onHand: 10 });
    const line = { ...sale(-1), referenceType: 'sale', referenceId: 's-1' };
    await service.applyMovement(em, line);
    await service.applyMovement(em, line);
    expect(posted(saved).map((m) => m.sourceEventId)).toEqual([
      'sale:s-1:v:l:sale',
      'sale:s-1:v:l:sale#2',
    ]);
  });

  it('treats a duplicate posting of the same source key as already applied', async () => {
    const { service, em, manager, level, saved } = setup({ onHand: 10 });
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('FROM stock_movements WHERE')
          ? [
              {
                id: 'm-1',
                quantity: 3,
                fromLocationId: 'l',
                toLocationId: null,
                cost: '2.5',
              },
            ]
          : [],
      ),
    );
    const result = await service.applyMovement(em, {
      ...sale(-3),
      sourceKey: 'sale:s-1:line-1',
    });
    expect(result.duplicate).toBe(true);
    expect(result.unitCost).toBe(2.5);
    expect(level.quantityOnHand).toBe(10);
    expect(posted(saved)).toHaveLength(0);
    expect(manager.increment).not.toHaveBeenCalled();

    // Same key, another quantity: a conflicting reuse
    await expect(
      service.applyMovement(em, { ...sale(-4), sourceKey: 'sale:s-1:line-1' }),
    ).rejects.toThrow(ConflictException);
  });

  it('checks the duplicate before refusing for stock (a retry of an applied sale)', async () => {
    const { service, em, manager } = setup({ onHand: 0 });
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('FROM stock_movements WHERE')
          ? [
              {
                id: 'm-1',
                quantity: 1,
                fromLocationId: 'l',
                toLocationId: null,
                cost: null,
              },
            ]
          : [],
      ),
    );
    await expect(
      service.applyMovement(em, { ...sale(-1), sourceKey: 'k' }),
    ).resolves.toMatchObject({ duplicate: true });
  });

  it('records the correlation id and the reversed movement', async () => {
    const { service, em, saved } = setup({ onHand: 10 });
    await requestContext.run({ requestId: 'req-42' }, () =>
      service.applyMovement(em, {
        ...sale(1, false),
        movementType: MovementType.RETURN,
        reversalOfId: 'm-0',
        sourceKey: null,
      }),
    );
    expect(posted(saved)[0]).toMatchObject({
      correlationId: 'req-42',
      reversalOfId: 'm-0',
      sourceEventId: null,
    });
  });

  it('moveBetween posts an out and an in leg at the same cost, locking both levels in order', async () => {
    const { service, em, manager, saved } = setup({ onHand: 10, cost: 3 });
    const result = await service.moveBetween(em, {
      tenantId: 't',
      userId: 'u',
      variantId: 'v',
      fromLocationId: 'l',
      toLocationId: 'a-transit',
      quantity: 4,
      movementType: MovementType.TRANSFER,
      sourceKey: 'stock_transfer:t1:e1:i1',
    });
    const rows = posted(saved);
    expect(rows.map((r) => r.sourceEventId)).toEqual([
      'stock_transfer:t1:e1:i1:out',
      'stock_transfer:t1:e1:i1:in',
    ]);
    expect(rows[1]).toMatchObject({ cost: 3 });
    expect(result.out.unitCost).toBe(3);
    const inserts = manager.query.mock.calls
      .filter(([sql]) => String(sql).includes('INSERT INTO stock_levels'))
      .map(([, params]) => (params as unknown as string[])[2]);
    expect(inserts.slice(0, 2)).toEqual(['a-transit', 'l']);
  });

  it('never updates or deletes a movement (the ledger is append-only)', () => {
    const dir = join(__dirname);
    for (const file of readdirSync(dir).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
    )) {
      const source = readFileSync(join(dir, file), 'utf8');
      expect(source).not.toMatch(/UPDATE\s+stock_movements/i);
      expect(source).not.toMatch(/DELETE\s+FROM\s+stock_movements/i);
      expect(source).not.toMatch(
        /(update|delete|softDelete)\(\s*StockMovement\b/,
      );
    }
  });

  it('the migration makes stock_movements append-only with a purge escape', () => {
    const migration = readFileSync(
      join(
        __dirname,
        '../database/migrations/1790430000000-CatalogInventoryExtras.ts',
      ),
      'utf8',
    );
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "stock_movements"');
    expect(migration).toContain(
      "RAISE EXCEPTION 'stock_movements is append-only",
    );
    expect(migration).toContain("current_setting('app.audit_purge', true)");
    expect(migration).toContain('uq_stock_movements_source_event');
    expect(migration).toContain('SET "allowBackorder" = false');
  });
});

describe('D018 on the adjustment and receipt paths', () => {
  function service() {
    const manager = {
      query: jest.fn((sql: string) =>
        Promise.resolve(sql.includes('MAX(') ? [{ max: 0 }] : []),
      ),
      findOne: jest.fn(() => Promise.resolve({ quantityOnHand: 2 })),
      // Variants with their unit (none: sold by the piece)
      find: jest.fn(() => Promise.resolve([])),
      save: jest.fn((row: object) => Promise.resolve({ id: 'adj-1', ...row })),
      create: jest.fn((_: unknown, data: object) => ({ ...data })),
    };
    const dataSource = {
      getRepository: () => ({
        exists: () => Promise.resolve(true),
        count: () => Promise.resolve(1),
      }),
      transaction: (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
    };
    const inventory = new InventoryService(
      {} as never,
      {} as never,
      { getSettings: jest.fn() } as unknown as SettingsService,
      dataSource as never,
      { record: jest.fn() } as unknown as AuditService,
    );
    return { inventory, manager };
  }

  it('an adjustment below zero is refused, never posted as oversell', async () => {
    const { inventory } = service();
    const apply = jest
      .spyOn(inventory, 'applyMovement')
      .mockRejectedValue(
        new BadRequestException('Not enough stock (2 on hand)'),
      );
    await expect(
      inventory.createAdjustment('t', 'u', {
        locationId: 'l',
        reason: AdjustmentReason.DAMAGE,
        mode: 'delta',
        items: [{ variantId: 'v', quantity: -5 }],
      }),
    ).rejects.toThrow('Not enough stock (2 on hand)');
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ delta: -5, respectReservations: false }),
    );
    expect(apply.mock.calls[0][1].allowOversell).toBeUndefined();
  });

  it('a receipt of damaged goods goes to the quarantine location', async () => {
    const { inventory } = service();
    jest
      .spyOn(inventory, 'resolveConditionLocation')
      .mockImplementation((_m, _t, locationId, condition) =>
        Promise.resolve(condition === 'damaged' ? 'quarantine' : locationId),
      );
    const apply = jest
      .spyOn(inventory, 'applyMovement')
      .mockResolvedValue({ unitCost: 1 } as never);
    await inventory.receiveStock('t', 'u', {
      locationId: 'shelf',
      items: [
        { variantId: 'v', quantity: 5 },
        { variantId: 'v', quantity: 1, condition: 'damaged' },
      ],
    });
    expect(apply.mock.calls.map(([, input]) => input.locationId)).toEqual([
      'shelf',
      'quarantine',
    ]);
  });
});

describe('InventoryService.applyMovement: stock.adjusted outbox event', () => {
  it('records stock.adjusted in the same manager with the quantities after the change', async () => {
    const outbox = { record: jest.fn(() => Promise.resolve('e1')) };
    const { service, em, level } = setup({ onHand: 5, reserved: 1, outbox });
    (level as { id?: string }).id = 'level-1';
    await service.applyMovement(em, {
      ...sale(-2),
      referenceType: 'sale',
      referenceId: 'sale-1',
    });
    expect(outbox.record).toHaveBeenCalledTimes(1);
    expect(outbox.record).toHaveBeenCalledWith(em, {
      tenantId: 't',
      type: 'stock.adjusted',
      aggregateId: 'level-1',
      payload: {
        variantId: 'v',
        locationId: 'l',
        delta: -2,
        movementType: MovementType.SALE,
        quantityOnHand: 3,
        quantityAvailable: 2,
        referenceType: 'sale',
        referenceId: 'sale-1',
      },
    });
  });

  it('records nothing for a zero delta', async () => {
    const outbox = { record: jest.fn() };
    const { service, em } = setup({ onHand: 5, outbox });
    await service.applyMovement(em, sale(0));
    expect(outbox.record).not.toHaveBeenCalled();
  });
});

describe('InventoryService with decimal (measured) quantities', () => {
  it('posts weighed sales without floating point drift', async () => {
    // 0.3 kg on hand; 0.1 + 0.2 kg sold: exactly nothing left, not -5e-17
    const { service, em, level, saved } = setup({ onHand: 0.3 });
    await service.applyMovement(em, sale(-0.1));
    await service.applyMovement(em, sale(-0.2));
    expect(level.quantityOnHand).toBe(0);
    expect(level.quantityAvailable).toBe(0);
    expect(saved).toContainEqual(
      expect.objectContaining({
        quantity: 0.2,
        movementType: MovementType.SALE,
      }),
    );
    // Nothing left: the next gram is refused (D018)
    await expect(service.applyMovement(em, sale(-0.001))).rejects.toThrow(
      'Not enough stock (0 available)',
    );
  });

  it('allows exactly what is available after reservations (0.3 − 0.1 − 0.2)', async () => {
    const { service, em, level } = setup({ onHand: 0.3, reserved: 0.1 });
    await service.applyMovement(em, sale(-0.2));
    expect(level).toMatchObject({
      quantityOnHand: 0.1,
      quantityReserved: 0.1,
      quantityAvailable: 0,
    });
  });

  it('receives decimals and keeps 4 places', async () => {
    const { service, em, level } = setup({ onHand: 1.1 });
    await service.applyMovement(em, {
      ...sale(2.2),
      movementType: MovementType.PURCHASE,
      cost: 3,
    });
    expect(level.quantityOnHand).toBe(3.3);
    await service.applyMovement(em, {
      ...sale(0.00004),
      movementType: MovementType.PURCHASE,
    });
    // Rounded to what numeric(19,4) stores
    expect(level.quantityOnHand).toBe(3.3);
  });

  it('reserves and releases decimal quantities exactly', async () => {
    const { service, em, level } = setup({ onHand: 1 });
    for (const quantity of [0.1, 0.2, 0.3]) {
      await service.reserve(em, {
        tenantId: 't',
        variantId: 'v',
        locationId: 'l',
        quantity,
        referenceType: 'held_cart',
        referenceId: `cart-${quantity}`,
      });
    }
    expect(level).toMatchObject({
      quantityReserved: 0.6,
      quantityAvailable: 0.4,
    });
    await expect(
      service.reserve(em, {
        tenantId: 't',
        variantId: 'v',
        locationId: 'l',
        quantity: 0.4001,
        referenceType: 'held_cart',
        referenceId: 'cart-x',
      }),
    ).rejects.toThrow('Not enough stock to reserve (0.4 available)');
    await expect(
      service.reserve(em, {
        tenantId: 't',
        variantId: 'v',
        locationId: 'l',
        quantity: 0.00001,
        referenceType: 'held_cart',
        referenceId: 'cart-y',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('expires decimal reservations exactly', async () => {
    const { service, em, level } = setup({
      onHand: 1,
      reserved: 0.3,
      expired: [0.1, 0.2],
    });
    await service.applyMovement(em, sale(-1));
    expect(level).toMatchObject({
      quantityOnHand: 0,
      quantityReserved: 0,
      quantityAvailable: 0,
    });
  });

  it('refuses decimals for items sold by the piece when adjusting', async () => {
    const manager = {
      query: jest.fn((sql: string) =>
        Promise.resolve(sql.includes('MAX(') ? [{ max: 0 }] : []),
      ),
      find: jest.fn(() =>
        Promise.resolve([
          {
            id: 'v',
            sku: 'SOAP',
            product: { unit: null },
          },
        ]),
      ),
      save: jest.fn((row: object) => Promise.resolve({ id: 'adj-1', ...row })),
      create: jest.fn((_: unknown, data: object) => ({ ...data })),
    };
    const dataSource = {
      getRepository: () => ({
        exists: () => Promise.resolve(true),
        count: () => Promise.resolve(1),
      }),
      transaction: (work: (m: EntityManager) => Promise<unknown>) =>
        work(manager as unknown as EntityManager),
    };
    const inventory = new InventoryService(
      {} as never,
      {} as never,
      { getSettings: jest.fn() } as unknown as SettingsService,
      dataSource as never,
      { record: jest.fn() } as unknown as AuditService,
    );
    const apply = jest.spyOn(inventory, 'applyMovement');
    await expect(
      inventory.createAdjustment('t', 'u', {
        locationId: 'l',
        reason: AdjustmentReason.DAMAGE,
        mode: 'delta',
        items: [{ variantId: 'v', quantity: -1.5 }],
      }),
    ).rejects.toThrow('SOAP: Quantity must be a whole number');
    expect(apply).not.toHaveBeenCalled();
  });
});
