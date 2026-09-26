import { EXPIRABLE_RESERVATION } from './reservation-expiry.service';
import { AuditService } from '../audit/audit.service';
import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { StockLevel } from '../database/entities/stock-level.entity';
import {
  MovementType,
  StockMovement,
} from '../database/entities/stock-movement.entity';
import {
  AdjustmentReason,
  AdjustmentStatus,
  StockAdjustment,
} from '../database/entities/stock-adjustment.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { ProductUnit } from '../database/entities/product-unit.entity';
import {
  InventoryLocation,
  LocationStockStatus,
  LocationType,
} from '../database/entities/inventory-location.entity';
import {
  Warehouse,
  WarehouseType,
} from '../database/entities/warehouse.entity';
import { requestContext } from '../common/context/request-context';
import {
  accessibleLocationIds,
  assertLocationAccess,
  branchLocationIdsSql,
  locationFilterSql,
  scopedBranchIds,
} from '../auth/branch-scope';
import { hiddenFieldsFor } from '../auth/sensitive-fields';
import { nextDocumentNumber } from '../common/utils/sequence';
import { StockCostLayer } from '../database/entities/stock-cost-layer.entity';
import {
  addQty,
  isQuantityValue,
  roundQty,
  subQty,
  sumQty,
} from '../common/utils/quantity';
import { assertUnitQuantities } from '../products/variant-units';
import {
  ReservationStatus,
  StockReservation,
} from '../database/entities/stock-reservation.entity';
import {
  consumeLayers,
  inboundLayerQuantity,
  round4,
  weightedAverageCost,
} from './costing';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string | undefined): value is string =>
  !!value && UUID_PATTERN.test(value);
import { SettingsService } from '../settings/settings.service';
import { OutboxService } from '../platform/outbox/outbox.service';
import {
  agingBucket,
  AGING_BUCKETS,
  canGoOut,
  daysSince,
  defaultSourceKey,
  GoodsCondition,
  isSameMovement,
  pickConditionLocation,
  SOURCE_KEY_MAX,
  sourceKeyWithOccurrence,
} from './stock-rules';
import {
  AgingQueryDto,
  ChangeCostingMethodDto,
  CreateAdjustmentDto,
  RevalueCostDto,
  MovementsQueryDto,
  ReceiveStockDto,
  ReservationsQueryDto,
  StockQueryDto,
} from './inventory.dto';
import { containsPattern } from '../common/utils/like';

export interface MovementInput {
  tenantId: string;
  userId: string;
  variantId: string;
  locationId: string;
  // Positive adds stock to the location, negative removes it
  delta: number;
  movementType: MovementType;
  referenceType?: string;
  referenceId?: string;
  referenceNumber?: string;
  // Inbound: the unit cost of the units coming in (purchase cost). When omitted,
  // inbound units are valued at the variant's current cost (returns, count gains).
  // Outbound: ignored for valuation; the costed unit cost is returned instead.
  cost?: number | null;
  notes?: string;
  /**
   * @deprecated D018: ignored. Outbound movements never take stock below zero
   * (on hand, and available = on hand − reserved) unless `allowOversell` is set.
   */
  preventNegative?: boolean;
  /**
   * Only for sales that already happened (offline) and are flagged for oversell
   * review: the movement is posted even if it takes stock below zero.
   * Every other caller leaves it unset.
   */
  allowOversell?: boolean;
  /**
   * Reserved units are not available to outbound movements (default true).
   * Stock counts pass false: a count corrects the physical on-hand quantity.
   */
  respectReservations?: boolean;
  /**
   * Unique identity of the business event, stored as sourceEventId (unique per
   * store). Posting the same key again with the same quantity is a no-op that
   * returns the current level (idempotent); with another quantity it is a 409.
   * Default: referenceType:referenceId:variant:location:movementType (plus #n
   * for repeats inside one transaction); none without a referenceId.
   * Pass an explicit key when one reference legitimately posts the same
   * movement more than once in separate transactions (e.g. several dispatches).
   * Pass null to post without a key.
   */
  sourceKey?: string | null;
  // The movement this one reverses
  reversalOfId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * The stock level after a movement, plus the costed unit cost of the movement:
 * outbound → average: the variant's current cost; FIFO: weighted cost of the
 * layers consumed. Inbound → the cost the units came in at.
 */
export type AppliedMovement = StockLevel & {
  unitCost: number;
  // The same source key was already posted: nothing was changed this time
  duplicate?: boolean;
};

export interface ReserveInput {
  tenantId: string;
  variantId: string;
  locationId: string;
  quantity: number;
  referenceType: string;
  referenceId: string;
  // Null/undefined = held until released
  expiresAt?: Date | null;
  /** @deprecated D018: ignored. A reservation never exceeds the available units unless allowOversell. */
  preventNegative?: boolean;
  // Reserve even if fewer units are available (sales' oversell review cases only)
  allowOversell?: boolean;
}

export interface RevaluationSummary {
  kind: 'manual' | 'costing_method_change';
  quantity: number;
  beforeCost: number | null;
  afterCost: number;
  valueBefore: number;
  valueAfter: number;
  valueChange: number;
}

export interface ReleaseInput {
  tenantId: string;
  referenceType: string;
  referenceId: string;
  // 'committed' when the reserved goods were sold (default 'released')
  status?: ReservationStatus.RELEASED | ReservationStatus.COMMITTED;
}

const ADJUSTMENT_MOVEMENT: Record<AdjustmentReason, MovementType> = {
  [AdjustmentReason.RECOUNT]: MovementType.RECOUNT,
  [AdjustmentReason.DAMAGE]: MovementType.DAMAGE,
  [AdjustmentReason.THEFT]: MovementType.THEFT,
  [AdjustmentReason.EXPIRY]: MovementType.ADJUSTMENT,
  [AdjustmentReason.OTHER]: MovementType.ADJUSTMENT,
};

@Injectable()
export class InventoryService {
  // Default source keys already used per transaction (see resolveSourceKey)
  private readonly keyOccurrences = new WeakMap<
    EntityManager,
    Map<string, number>
  >();

  constructor(
    @InjectRepository(StockLevel)
    private stockLevelRepository: Repository<StockLevel>,
    @InjectRepository(StockMovement)
    private movementRepository: Repository<StockMovement>,
    private settingsService: SettingsService,
    private dataSource: DataSource,
    private auditService: AuditService,
    @Optional() private outbox?: OutboxService,
  ) {}

  /**
   * Apply one stock change at a location: updates the stock level (row-locked),
   * the variant's total quantity and cost, the FIFO cost layers, and records the
   * movement. Call inside a transaction.
   *
   * Lock order (keep it everywhere to avoid deadlocks): stock level → variant →
   * cost layers / reservations.
   */
  async applyMovement(
    manager: EntityManager,
    movement: MovementInput,
  ): Promise<AppliedMovement> {
    // Decimal quantities (measured items) are kept to 4 places, like the columns
    const input = { ...movement, delta: roundQty(movement.delta) };
    const { tenantId, variantId, locationId, delta } = input;

    const level = await this.lockLevel(
      manager,
      tenantId,
      variantId,
      locationId,
    );

    // Ledger integrity: the same business event is never posted twice
    const sourceEventId = this.resolveSourceKey(manager, input);
    if (sourceEventId && delta !== 0) {
      const existing = await this.findBySourceKey(
        manager,
        tenantId,
        sourceEventId,
      );
      if (existing) {
        if (!isSameMovement(existing, locationId, delta)) {
          throw new ConflictException(
            `Stock movement ${sourceEventId} was already posted with another quantity`,
          );
        }
        return Object.assign(level, {
          unitCost: Number(existing.cost ?? 0),
          duplicate: true,
        });
      }
    }

    // D018: never below zero, unless an offline sale is flagged for review
    if (delta < 0 && !input.allowOversell) {
      const respectReservations = input.respectReservations !== false;
      let refusal = canGoOut(level, -delta, { respectReservations });
      if (refusal && respectReservations && level.quantityReserved > 0) {
        // Reservations past their expiry no longer hold stock
        await this.expireStaleAt(manager, level);
        refusal = canGoOut(level, -delta, { respectReservations });
      }
      if (refusal) throw new BadRequestException(refusal);
    }

    const onHandBefore = Number(level.quantityOnHand);
    const onHand = addQty(onHandBefore, delta);
    level.quantityOnHand = onHand;
    level.quantityAvailable = subQty(onHand, level.quantityReserved);
    if (input.movementType === MovementType.PURCHASE && delta > 0) {
      level.lastReceivedAt = new Date();
    }
    if (input.movementType === MovementType.RECOUNT) {
      level.lastCountedAt = new Date();
    }
    await manager.save(level);

    const unitCost = await this.applyCosting(manager, input, onHandBefore);

    await manager.increment(
      ProductVariant,
      { id: variantId, tenantId },
      'stockQuantity',
      delta,
    );

    if (delta !== 0) {
      await manager.save(
        manager.create(StockMovement, {
          tenantId,
          variantId,
          fromLocationId: delta < 0 ? locationId : undefined,
          toLocationId: delta > 0 ? locationId : undefined,
          movementType: input.movementType,
          quantity: Math.abs(delta),
          referenceType: input.referenceType,
          referenceId: input.referenceId,
          referenceNumber: input.referenceNumber,
          cost: delta > 0 ? (input.cost ?? unitCost) : unitCost,
          userId: input.userId,
          notes: input.notes,
          sourceEventId,
          correlationId: this.correlationId(),
          reversalOfId: input.reversalOfId ?? null,
          metadata: {
            ...(input.metadata ?? {}),
            ...(input.allowOversell && onHand < 0
              ? { oversell: true, onHandAfter: onHand }
              : {}),
          },
        }),
      );

      // Same transaction as the change (low stock alerts, projections)
      await this.outbox?.record(manager, {
        tenantId,
        type: 'stock.adjusted',
        aggregateId: level.id,
        payload: {
          variantId,
          locationId,
          delta,
          movementType: input.movementType,
          quantityOnHand: Number(level.quantityOnHand),
          quantityAvailable: Number(level.quantityAvailable),
          referenceType: input.referenceType ?? null,
          referenceId: input.referenceId ?? null,
        },
      });
    }

    return Object.assign(level, { unitCost });
  }

  /**
   * Move units between two locations of the store (transfers, transit legs,
   * quarantine): an outbound movement at `from` (costed) and an inbound one at
   * `to` at the same unit cost. Both levels are locked in id order first so two
   * opposite moves can't deadlock. Keys get ":out" / ":in".
   */
  async moveBetween(
    manager: EntityManager,
    input: Omit<MovementInput, 'locationId' | 'delta' | 'cost'> & {
      fromLocationId: string;
      toLocationId: string;
      quantity: number;
      // Cost of the inbound leg; default: what the outbound leg was costed at
      inboundCost?: number | null;
    },
  ): Promise<{ out: AppliedMovement; in: AppliedMovement }> {
    const { fromLocationId, toLocationId, quantity, ...rest } = input;
    if (fromLocationId === toLocationId) {
      throw new BadRequestException('The two locations must differ');
    }
    for (const locationId of [fromLocationId, toLocationId].sort()) {
      await this.lockLevel(
        manager,
        input.tenantId,
        input.variantId,
        locationId,
      );
    }
    const key = input.sourceKey;
    const out = await this.applyMovement(manager, {
      ...rest,
      locationId: fromLocationId,
      delta: -quantity,
      sourceKey: key ? `${key}:out` : key,
      metadata: { ...(input.metadata ?? {}), toLocationId },
    });
    const inbound = await this.applyMovement(manager, {
      ...rest,
      locationId: toLocationId,
      delta: quantity,
      cost: input.inboundCost ?? out.unitCost,
      sourceKey: key ? `${key}:in` : key,
      metadata: { ...(input.metadata ?? {}), fromLocationId },
    });
    return { out, in: inbound };
  }

  /**
   * The store's transit location (units of dispatched transfers until they are
   * received). Created on first use in a system warehouse of type "transit".
   */
  async transitLocationId(
    manager: EntityManager,
    tenantId: string,
  ): Promise<string> {
    const find = () =>
      manager.findOne(InventoryLocation, {
        where: { tenantId, stockStatus: LocationStockStatus.TRANSIT },
        order: { createdAt: 'ASC' },
      });
    const existing = await find();
    if (existing) return existing.id;

    // One creator at a time per store
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `transit-location:${tenantId}`,
    ]);
    const again = await find();
    if (again) return again.id;

    let warehouse = await manager.findOne(Warehouse, {
      where: { tenantId, warehouseType: WarehouseType.TRANSIT },
      order: { createdAt: 'ASC' },
    });
    warehouse ??= await manager.save(
      manager.create(Warehouse, {
        tenantId,
        code: `TRANSIT-${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'In transit',
        warehouseType: WarehouseType.TRANSIT,
      }),
    );
    const location = await manager.save(
      manager.create(InventoryLocation, {
        tenantId,
        warehouseId: warehouse.id,
        code: 'TRANSIT',
        name: 'In transit',
        locationType: LocationType.ZONE,
        isSellable: false,
        stockStatus: LocationStockStatus.TRANSIT,
      }),
    );
    return location.id;
  }

  /**
   * Where goods in a condition go (returns, receipts): damaged goods go to the
   * damaged / quarantine location of the same warehouse when there is one.
   * For the returns and purchasing flows.
   */
  async resolveConditionLocation(
    manager: EntityManager,
    tenantId: string,
    locationId: string,
    condition: GoodsCondition,
  ): Promise<string> {
    if (condition !== 'damaged') return locationId;
    const location = await manager.findOne(InventoryLocation, {
      where: { tenantId, id: locationId },
      select: { id: true, warehouseId: true },
    });
    if (!location) throw new NotFoundException('Location not found');
    const siblings = await manager.find(InventoryLocation, {
      where: { tenantId, warehouseId: location.warehouseId },
      select: { id: true, stockStatus: true },
      order: { code: 'ASC' },
    });
    return pickConditionLocation(locationId, condition, siblings);
  }

  private resolveSourceKey(
    manager: EntityManager,
    input: MovementInput,
  ): string | null {
    if (input.sourceKey === null) return null;
    if (input.sourceKey) return input.sourceKey.slice(0, SOURCE_KEY_MAX);
    const base = defaultSourceKey(input);
    if (!base) return null;
    let seen = this.keyOccurrences.get(manager);
    if (!seen) {
      seen = new Map();
      this.keyOccurrences.set(manager, seen);
    }
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    return sourceKeyWithOccurrence(base, occurrence);
  }

  private async findBySourceKey(
    manager: EntityManager,
    tenantId: string,
    sourceEventId: string,
  ) {
    const rows = await manager.query<
      {
        id: string;
        quantity: number;
        fromLocationId: string | null;
        toLocationId: string | null;
        cost: string | null;
      }[]
    >(
      `SELECT id, quantity, "fromLocationId", "toLocationId", cost
         FROM stock_movements WHERE "tenantId" = $1 AND "sourceEventId" = $2 LIMIT 1`,
      [tenantId, sourceEventId],
    );
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  }

  private correlationId(): string | null {
    const id = requestContext.get()?.requestId;
    return id ? String(id).slice(0, 100) : null;
  }

  /**
   * Valuation side of a movement: FIFO layers and the variant's unit cost.
   * Returns the movement's unit cost. Runs after the stock level is locked.
   */
  private async applyCosting(
    manager: EntityManager,
    input: MovementInput,
    onHandBefore: number,
  ): Promise<number> {
    const { tenantId, variantId, locationId, delta } = input;
    const variant = await manager.findOne(ProductVariant, {
      where: { id: variantId, tenantId },
      select: { id: true, cost: true, stockQuantity: true },
      lock: { mode: 'pessimistic_write' },
    });
    const currentCost =
      variant?.cost === null || variant?.cost === undefined
        ? null
        : Number(variant.cost);
    if (delta === 0 || !variant) return currentCost ?? 0;

    const { costingMethod } = await this.settingsService.getSettings(tenantId);

    if (delta > 0) {
      const explicitCost =
        input.cost === null || input.cost === undefined
          ? null
          : round4(Number(input.cost));
      const unitCost = explicitCost ?? currentCost ?? 0;
      const layerQuantity = inboundLayerQuantity(onHandBefore, delta);
      if (layerQuantity > 0) {
        await manager.insert(StockCostLayer, {
          tenantId,
          variantId,
          locationId,
          quantityReceived: layerQuantity,
          quantityRemaining: layerQuantity,
          unitCost,
          sourceType: input.referenceType ?? input.movementType,
          sourceId: isUuid(input.referenceId) ? input.referenceId : null,
        });
      }
      if (explicitCost !== null) {
        let newCost: number | null = null;
        if (costingMethod === 'average') {
          newCost = weightedAverageCost(
            variant.stockQuantity,
            currentCost,
            delta,
            explicitCost,
          );
        } else if (
          input.movementType === MovementType.PURCHASE ||
          currentCost === null
        ) {
          // FIFO: the variant's cost is the latest purchase cost (used for
          // stock not covered by layers and as the catalog's reference cost)
          newCost = explicitCost;
        }
        if (newCost !== null && newCost !== currentCost) {
          await manager.update(
            ProductVariant,
            { id: variantId, tenantId },
            { cost: newCost },
          );
        }
      }
      return unitCost;
    }

    // Outbound: consume the oldest layers first
    const layers = await manager
      .getRepository(StockCostLayer)
      .createQueryBuilder('layer')
      .where('layer.tenantId = :tenantId', { tenantId })
      .andWhere('layer.variantId = :variantId', { variantId })
      .andWhere('layer.locationId = :locationId', { locationId })
      .andWhere('layer.quantityRemaining > 0')
      .orderBy('layer.receivedAt', 'ASC')
      .addOrderBy('layer.createdAt', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    const consumption = consumeLayers(
      layers.map((l) => ({
        id: l.id,
        quantityRemaining: l.quantityRemaining,
        unitCost: Number(l.unitCost),
      })),
      -delta,
      currentCost ?? 0,
    );
    for (const take of consumption.takes) {
      await manager.decrement(
        StockCostLayer,
        { id: take.id },
        'quantityRemaining',
        take.quantity,
      );
    }
    return costingMethod === 'fifo' ? consumption.unitCost : (currentCost ?? 0);
  }

  /**
   * Hold stock for a held cart / order. Increases quantityReserved (and lowers
   * quantityAvailable) at the location until released, committed or expired.
   * D018: refused when fewer units are available, unless allowOversell.
   * Call inside a transaction.
   */
  async reserve(
    manager: EntityManager,
    input: ReserveInput,
  ): Promise<StockReservation> {
    const { tenantId, variantId, locationId, quantity } = input;
    if (!isQuantityValue(quantity) || quantity <= 0) {
      throw new BadRequestException(
        'Reserved quantity must be greater than zero, with at most 4 decimals',
      );
    }

    const level = await this.lockLevel(
      manager,
      tenantId,
      variantId,
      locationId,
    );
    await this.expireStaleAt(manager, level);

    const available = subQty(level.quantityOnHand, level.quantityReserved);
    if (!input.allowOversell && available < quantity) {
      throw new BadRequestException(
        `Not enough stock to reserve (${available} available)`,
      );
    }

    level.quantityReserved = addQty(level.quantityReserved, quantity);
    level.quantityAvailable = subQty(
      level.quantityOnHand,
      level.quantityReserved,
    );
    await manager.save(level);

    return manager.save(
      manager.create(StockReservation, {
        tenantId,
        variantId,
        locationId,
        quantity,
        referenceType: input.referenceType,
        referenceId: input.referenceId,
        expiresAt: input.expiresAt ?? null,
        status: ReservationStatus.ACTIVE,
      }),
    );
  }

  /**
   * Release every active reservation of a reference (e.g. a held cart). Pass
   * status 'committed' when the goods were sold; do this BEFORE the sale's
   * applyMovement so the units count as available again for that sale.
   * Returns the reservations that were closed. Call inside a transaction.
   */
  async releaseReservations(
    manager: EntityManager,
    input: ReleaseInput,
  ): Promise<StockReservation[]> {
    const { tenantId, referenceType, referenceId } = input;
    const active = await manager.find(StockReservation, {
      where: {
        tenantId,
        referenceType,
        referenceId,
        status: ReservationStatus.ACTIVE,
      },
    });
    if (active.length === 0) return [];

    // Lock the stock levels first (same order as applyMovement / reserve)
    const levelKeys = [
      ...new Set(active.map((r) => `${r.variantId}:${r.locationId}`)),
    ].sort();
    for (const key of levelKeys) {
      const [variantId, locationId] = key.split(':');
      await this.lockLevel(manager, tenantId, variantId, locationId);
    }

    const closed = await this.closeReservations(
      manager,
      { tenantId, referenceType, referenceId },
      input.status ?? ReservationStatus.RELEASED,
    );
    return closed;
  }

  /**
   * Expire every overdue reservation at one (locked) stock level and update the
   * level in memory. The caller saves the level.
   */
  async expireStaleAt(manager: EntityManager, level: StockLevel) {
    const rows = await manager.query<{ quantity: number }[]>(
      // Never releases stock of a sale whose card payment outcome is still open
      `UPDATE stock_reservations r
         SET status = 'expired', "closedAt" = NOW(), updated_at = NOW()
       WHERE r."tenantId" = $1 AND r."variantId" = $2 AND r."locationId" = $3
         AND r.status = 'active' AND r."expiresAt" IS NOT NULL AND r."expiresAt" <= NOW()
         AND ${EXPIRABLE_RESERVATION}
       RETURNING r.quantity`,
      [level.tenantId, level.variantId, level.locationId],
    );
    // node-postgres returns [rows, count] for UPDATE ... RETURNING
    const returned = Array.isArray(rows[0]) ? (rows[0] as typeof rows) : rows;
    const expired = sumQty(returned.map((r) => Number(r.quantity)));
    if (expired > 0) {
      level.quantityReserved = Math.max(
        0,
        subQty(level.quantityReserved, expired),
      );
      level.quantityAvailable = subQty(
        level.quantityOnHand,
        level.quantityReserved,
      );
      await manager.save(level);
    }
    return expired;
  }

  /**
   * Close active reservations matching `where` and give their quantities back to
   * the (already locked) stock levels.
   */
  private async closeReservations(
    manager: EntityManager,
    where: { tenantId: string; referenceType: string; referenceId: string },
    status: ReservationStatus,
  ): Promise<StockReservation[]> {
    const result = await manager
      .createQueryBuilder()
      .update(StockReservation)
      .set({ status, closedAt: () => 'NOW()' })
      .where('"tenantId" = :tenantId', { tenantId: where.tenantId })
      .andWhere('"referenceType" = :referenceType', {
        referenceType: where.referenceType,
      })
      .andWhere('"referenceId" = :referenceId', {
        referenceId: where.referenceId,
      })
      .andWhere('status = :active', { active: ReservationStatus.ACTIVE })
      .returning('*')
      .execute();
    const closed = (result.raw as StockReservation[]) ?? [];

    const perLevel = new Map<string, number>();
    for (const r of closed) {
      const key = `${r.variantId}:${r.locationId}`;
      perLevel.set(key, addQty(perLevel.get(key) ?? 0, Number(r.quantity)));
    }
    for (const [key, quantity] of perLevel) {
      const [variantId, locationId] = key.split(':');
      await manager.query(
        `UPDATE stock_levels
           SET "quantityReserved" = GREATEST("quantityReserved" - $4, 0),
               "quantityAvailable" = "quantityOnHand" - GREATEST("quantityReserved" - $4, 0),
               version = version + 1, updated_at = NOW()
         WHERE "tenantId" = $1 AND "variantId" = $2 AND "locationId" = $3`,
        [where.tenantId, variantId, locationId, quantity],
      );
    }
    return closed;
  }

  /**
   * Change the units in transit towards a location (stock transfers). Not on
   * hand anywhere until received. Call inside a transaction.
   */
  async adjustInTransit(
    manager: EntityManager,
    input: {
      tenantId: string;
      variantId: string;
      locationId: string;
      delta: number;
    },
  ): Promise<StockLevel> {
    const level = await this.lockLevel(
      manager,
      input.tenantId,
      input.variantId,
      input.locationId,
    );
    level.quantityInTransit = Math.max(
      0,
      addQty(level.quantityInTransit, input.delta),
    );
    return manager.save(level);
  }

  /**
   * Reservations (default: active ones), newest first
   */
  async listReservations(tenantId: string, query: ReservationsQueryDto) {
    // Branch-limited users: reservations at their branches' locations (spec §9)
    const locations = await accessibleLocationIds(
      this.dataSource.manager,
      tenantId,
    );
    return this.dataSource.getRepository(StockReservation).find({
      where: {
        tenantId,
        status: query.status ?? ReservationStatus.ACTIVE,
        ...(query.variantId ? { variantId: query.variantId } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
        ...(locations && {
          locationId: In(
            query.locationId
              ? locations.filter((id) => id === query.locationId)
              : locations,
          ),
        }),
      },
      relations: { variant: { product: true }, location: true },
      order: { createdAt: 'DESC' },
      take: 500,
    });
  }

  /**
   * Create the stock level row if missing, then lock it for the rest of the transaction
   */
  private async lockLevel(
    manager: EntityManager,
    tenantId: string,
    variantId: string,
    locationId: string,
  ): Promise<StockLevel> {
    await manager.query(
      `INSERT INTO stock_levels (id, "tenantId", "variantId", "locationId", created_at, updated_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, NOW(), NOW())
       ON CONFLICT ("variantId", "locationId") DO NOTHING`,
      [tenantId, variantId, locationId],
    );
    return manager.findOneOrFail(StockLevel, {
      where: { tenantId, variantId, locationId },
      lock: { mode: 'pessimistic_write' },
    });
  }

  /**
   * Stock per variant and location
   */
  async listStock(tenantId: string, query: StockQueryDto) {
    const qb = this.dataSource
      .createQueryBuilder()
      .select([
        'variant.id AS "variantId"',
        'variant.sku AS sku',
        'variant.barcode AS barcode',
        'variant.name AS "variantName"',
        'product.id AS "productId"',
        'product.name AS "productName"',
        'product.reorderPoint AS "reorderPoint"',
        'location.id AS "locationId"',
        'location.code AS "locationCode"',
        'location.name AS "locationName"',
        'location.stockStatus AS "stockStatus"',
        'COALESCE(level.quantityOnHand, 0) AS "quantityOnHand"',
        'COALESCE(level.quantityAvailable, 0) AS "quantityAvailable"',
        'COALESCE(level.quantityReserved, 0) AS "quantityReserved"',
        'COALESCE(level.quantityInTransit, 0) AS "quantityInTransit"',
        'variant.cost AS cost',
        'level.lastCountedAt AS "lastCountedAt"',
        'level.lastReceivedAt AS "lastReceivedAt"',
        // Unit of measure: quantities of measured items are shown with its precision
        'unit.code AS "unitCode"',
        'COALESCE(unit.allowsDecimals, false) AS "unitAllowsDecimals"',
        'COALESCE(unit.precision, 0) AS "unitPrecision"',
      ])
      .from(ProductVariant, 'variant')
      .innerJoin('variant.product', 'product')
      .leftJoin(
        ProductUnit,
        'unit',
        'unit.id = product.unitId AND unit.tenantId = product.tenantId',
      )
      .innerJoin(
        InventoryLocation,
        'location',
        'location.tenantId = variant.tenantId',
      )
      .leftJoin(
        StockLevel,
        'level',
        'level.variantId = variant.id AND level.locationId = location.id',
      )
      .where('variant.tenantId = :tenantId', { tenantId })
      .andWhere("variant.status != 'discontinued'")
      .orderBy('product.name', 'ASC')
      .addOrderBy('variant.sku', 'ASC')
      .limit(1000);

    if (query.locationId) {
      qb.andWhere('location.id = :locationId', {
        locationId: query.locationId,
      });
    } else {
      // The transit location is shown on its own (GET ?locationId=), not in every listing
      qb.andWhere('location.stockStatus != :transit', {
        transit: LocationStockStatus.TRANSIT,
      });
    }
    // Branch-limited users: the locations of their branches' warehouses (spec §9)
    const scope = locationFilterSql('"location"."id"');
    if (scope) qb.andWhere(scope.sql, scope.params);
    if (query.sellableOnly) {
      // What can be sold: sellable locations only (not quarantine / damaged / transit)
      qb.andWhere('location.stockStatus = :sellable', {
        sellable: LocationStockStatus.SELLABLE,
      });
    }
    if (query.search) {
      qb.andWhere(
        '(variant.sku ILIKE :search OR variant.barcode ILIKE :search OR product.name::text ILIKE :search)',
        { search: containsPattern(query.search) },
      );
    }
    if (query.lowStock) {
      const { lowStockThreshold } =
        await this.settingsService.getSettings(tenantId);
      qb.andWhere(
        'COALESCE(level.quantityOnHand, 0) <= COALESCE(product.reorderPoint, :threshold)',
        {
          threshold: lowStockThreshold,
        },
      );
    }

    return qb.getRawMany();
  }

  /**
   * Units available to sell per variant: on hand − reserved, summed over
   * sellable locations only (quarantine, damaged and transit stock excluded).
   * For catalog / reporting views that show one availability per variant.
   */
  async sellableAvailability(
    tenantId: string,
    variantIds: string[],
  ): Promise<Map<string, number>> {
    if (variantIds.length === 0) return new Map();
    const rows = await this.dataSource.query<
      { variantId: string; available: string }[]
    >(
      `SELECT l."variantId", SUM(l."quantityOnHand" - l."quantityReserved") AS available
         FROM stock_levels l
         JOIN inventory_locations loc ON loc.id = l."locationId"
        WHERE l."tenantId" = $1 AND l."variantId" = ANY($2::uuid[])
          AND loc."stockStatus" = 'sellable'
        GROUP BY l."variantId"`,
      [tenantId, variantIds],
    );
    return new Map(rows.map((r) => [r.variantId, Number(r.available)]));
  }

  /**
   * Record a stock count or manual correction at one location
   */
  async createAdjustment(
    tenantId: string,
    userId: string,
    dto: CreateAdjustmentDto,
  ) {
    await this.assertLocation(tenantId, dto.locationId);
    await this.assertVariants(
      tenantId,
      dto.items.map((i) => i.variantId),
    );

    return this.dataSource.transaction(async (manager) => {
      // Decimals only for measured items (a delta may be negative: check its size)
      await assertUnitQuantities(
        manager,
        tenantId,
        dto.items.map((i) => ({
          variantId: i.variantId,
          quantity: Math.abs(i.quantity),
        })),
        { allowZero: true },
      );
      const adjustmentNumber = await nextDocumentNumber(manager, {
        table: 'stock_adjustments',
        column: 'adjustmentNumber',
        tenantId,
        prefix: 'ADJ',
      });

      const adjustment = await manager.save(
        manager.create(StockAdjustment, {
          tenantId,
          adjustmentNumber,
          locationId: dto.locationId,
          reason: dto.reason,
          userId,
          notes: dto.notes,
          status: AdjustmentStatus.COMPLETED,
        }),
      );

      const results: { variantId: string; before: number; after: number }[] =
        [];
      for (const item of dto.items) {
        let delta = item.quantity;
        let before = 0;
        if (dto.mode === 'set') {
          if (item.quantity < 0) {
            throw new BadRequestException(
              'Counted quantities cannot be negative',
            );
          }
          const current = await manager.findOne(StockLevel, {
            where: {
              tenantId,
              variantId: item.variantId,
              locationId: dto.locationId,
            },
            lock: { mode: 'pessimistic_write' },
          });
          before = Number(current?.quantityOnHand ?? 0);
          delta = subQty(item.quantity, before);
        }

        const level = await this.applyMovement(manager, {
          tenantId,
          userId,
          variantId: item.variantId,
          locationId: dto.locationId,
          delta,
          movementType: ADJUSTMENT_MOVEMENT[dto.reason],
          referenceType: 'adjustment',
          referenceId: adjustment.id,
          referenceNumber: adjustmentNumber,
          notes: dto.notes,
          // D018: never below zero on hand. An adjustment records what is
          // physically there, so reserved units don't block it.
          respectReservations: false,
        });
        results.push({
          variantId: item.variantId,
          before:
            dto.mode === 'set' ? before : subQty(level.quantityOnHand, delta),
          after: level.quantityOnHand,
        });
      }

      await this.auditService.record(
        {
          tenantId,
          action: 'inventory.adjusted',
          entityType: 'stock_adjustment',
          entityId: adjustment.id,
          reason: dto.notes ?? dto.reason,
          metadata: {
            adjustmentNumber,
            locationId: dto.locationId,
            reason: dto.reason,
            items: results,
          },
        },
        manager,
      );
      return { ...adjustment, items: results };
    });
  }

  /**
   * Add delivered stock at a location
   */
  async receiveStock(tenantId: string, userId: string, dto: ReceiveStockDto) {
    await this.assertLocation(tenantId, dto.locationId);
    // A variant may come twice: once in good condition, once damaged
    const lines = dto.items.map(
      (i) => `${i.variantId}:${i.condition ?? 'good'}`,
    );
    if (new Set(lines).size !== lines.length) {
      throw new BadRequestException(
        'Each variant can only appear once per condition',
      );
    }
    await this.assertVariants(tenantId, [
      ...new Set(dto.items.map((i) => i.variantId)),
    ]);

    return this.dataSource.transaction(async (manager) => {
      await assertUnitQuantities(manager, tenantId, dto.items);
      // Costing (average / FIFO layers) happens inside applyMovement
      const levels: StockLevel[] = [];
      for (const item of dto.items) {
        // Damaged goods go to the warehouse's quarantine location, if any
        const locationId = await this.resolveConditionLocation(
          manager,
          tenantId,
          dto.locationId,
          item.condition ?? 'good',
        );
        levels.push(
          await this.applyMovement(manager, {
            tenantId,
            userId,
            variantId: item.variantId,
            locationId,
            delta: item.quantity,
            movementType: MovementType.PURCHASE,
            referenceType: 'receipt',
            referenceNumber: dto.reference,
            cost: item.cost,
            notes: dto.notes,
            metadata:
              item.condition === 'damaged' ? { condition: 'damaged' } : {},
          }),
        );
      }
      await this.auditService.record(
        {
          tenantId,
          action: 'inventory.received',
          entityType: 'stock_receipt',
          entityId: dto.reference ?? null,
          metadata: { locationId: dto.locationId, items: dto.items },
        },
        manager,
      );
      return levels;
    });
  }

  /**
   * Manual cost revaluation: sets the variant's unit cost (and, under FIFO, the
   * cost of its remaining layers) and posts a zero-quantity REVALUATION entry
   * with the before/after cost and value. Audited.
   */
  async revalue(tenantId: string, userId: string, dto: RevalueCostDto) {
    const { costingMethod } = await this.settingsService.getSettings(tenantId);
    return this.dataSource.transaction(async (manager) => {
      const variant = await manager.findOne(ProductVariant, {
        where: { id: dto.variantId, tenantId },
        select: { id: true, sku: true, cost: true, stockQuantity: true },
        lock: { mode: 'pessimistic_write' },
      });
      if (!variant) throw new NotFoundException('Variant not found');
      const newCost = round4(dto.newCost);
      const entry = await this.postRevaluation(manager, {
        tenantId,
        userId,
        variant,
        newCost,
        recostLayers: costingMethod === 'fifo',
        kind: 'manual',
        reason: dto.reason.trim(),
      });
      await this.auditService.record(
        {
          tenantId,
          action: 'inventory.revalued',
          entityType: 'variant',
          entityId: variant.id,
          reason: dto.reason.trim(),
          changes: {
            before: { cost: entry.metadata.beforeCost },
            after: { cost: newCost },
          },
          metadata: { ...entry.metadata, movementId: entry.id },
        },
        manager,
      );
      return {
        movementId: entry.id,
        variantId: variant.id,
        sku: variant.sku,
        ...entry.metadata,
      };
    });
  }

  /**
   * Change the costing method of a store that holds stock (settings refuses it
   * then). Each variant is revalued so the books follow the new method, with a
   * REVALUATION entry per variant whose cost changes:
   * - to average: the unit cost becomes the weighted cost of its remaining FIFO layers;
   * - to FIFO: its remaining layers are re-costed at the current average cost
   *   (the stock value is unchanged; FIFO applies to what comes in next).
   * Then the setting is switched (as a settings version, audited).
   */
  async changeCostingMethod(
    tenantId: string,
    userId: string,
    dto: ChangeCostingMethodDto,
  ) {
    const { costingMethod } = await this.settingsService.getSettings(tenantId);
    if (costingMethod === dto.method) {
      throw new BadRequestException(`The store already uses ${dto.method}`);
    }
    const reason = dto.reason.trim();
    const entries = await this.dataSource.transaction(async (manager) => {
      const layerRows = await manager.query<
        { variantId: string; quantity: string; value: string }[]
      >(
        `SELECT "variantId", SUM("quantityRemaining") AS quantity,
                SUM("quantityRemaining" * "unitCost") AS value
           FROM stock_cost_layers
          WHERE "tenantId" = $1 AND "quantityRemaining" > 0
          GROUP BY "variantId"`,
        [tenantId],
      );
      const layered = new Map(
        layerRows.map((r) => [
          r.variantId,
          { quantity: Number(r.quantity), value: Number(r.value) },
        ]),
      );
      const variants = await manager.find(ProductVariant, {
        where: { tenantId },
        select: { id: true, sku: true, cost: true, stockQuantity: true },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      });
      const posted: Record<string, unknown>[] = [];
      for (const variant of variants) {
        const layers = layered.get(variant.id);
        if (!layers || layers.quantity <= 0) continue;
        const layerCost = round4(layers.value / layers.quantity);
        const current =
          variant.cost === null || variant.cost === undefined
            ? null
            : Number(variant.cost);
        if (dto.method === 'average') {
          if (current === layerCost) continue;
          const entry = await this.postRevaluation(manager, {
            tenantId,
            userId,
            variant,
            newCost: layerCost,
            recostLayers: false,
            kind: 'costing_method_change',
            reason,
          });
          posted.push({ movementId: entry.id, ...entry.metadata });
        } else {
          if (current === null || current === layerCost) continue;
          const entry = await this.postRevaluation(manager, {
            tenantId,
            userId,
            variant,
            newCost: current,
            beforeCost: layerCost,
            recostLayers: true,
            kind: 'costing_method_change',
            reason,
          });
          posted.push({ movementId: entry.id, ...entry.metadata });
        }
      }
      await this.auditService.record(
        {
          tenantId,
          action: 'inventory.costing_method_changed',
          entityType: 'settings',
          entityId: tenantId,
          reason,
          changes: {
            before: { costingMethod },
            after: { costingMethod: dto.method },
          },
          metadata: {
            revalued: posted.length,
            entries: posted.slice(0, 200),
          },
        },
        manager,
      );
      return posted;
    });
    await this.settingsService.updateSettings(
      tenantId,
      { costingMethod: dto.method, note: reason.slice(0, 500) },
      { costingMigration: true },
    );
    return { method: dto.method, revalued: entries.length, entries };
  }

  /**
   * Zero-quantity valuation entry. The variant row must be locked by the caller.
   */
  private async postRevaluation(
    manager: EntityManager,
    input: {
      tenantId: string;
      userId: string;
      variant: Pick<ProductVariant, 'id' | 'cost' | 'stockQuantity'>;
      newCost: number;
      // Default: the variant's current cost
      beforeCost?: number | null;
      recostLayers: boolean;
      kind: 'manual' | 'costing_method_change';
      reason: string;
    },
  ): Promise<{ id: string; metadata: RevaluationSummary }> {
    const { tenantId, variant, newCost } = input;
    const current =
      variant.cost === null || variant.cost === undefined
        ? null
        : Number(variant.cost);
    const beforeCost =
      input.beforeCost === undefined ? current : input.beforeCost;
    const quantity = Number(variant.stockQuantity ?? 0);
    if (input.recostLayers) {
      await manager.query(
        `UPDATE stock_cost_layers SET "unitCost" = $3, updated_at = NOW()
          WHERE "tenantId" = $1 AND "variantId" = $2 AND "quantityRemaining" > 0`,
        [tenantId, variant.id, newCost],
      );
    }
    if (current !== newCost) {
      await manager.update(
        ProductVariant,
        { id: variant.id, tenantId },
        { cost: newCost },
      );
    }
    const referenceId = randomUUID();
    const valuation = {
      beforeCost,
      afterCost: newCost,
      valueBefore: round4(quantity * Number(beforeCost ?? 0)),
      valueAfter: round4(quantity * newCost),
      valueChange: round4(quantity * (newCost - Number(beforeCost ?? 0))),
    };
    const movement = await manager.save(
      manager.create(StockMovement, {
        tenantId,
        variantId: variant.id,
        movementType: MovementType.REVALUATION,
        quantity: 0,
        referenceType: 'revaluation',
        referenceId,
        cost: newCost,
        userId: input.userId,
        notes: input.reason.slice(0, 500),
        sourceEventId: `revaluation:${referenceId}`,
        correlationId: this.correlationId(),
        // Costs sit under `valuation`, left out of the movement list for
        // people without inventory.cost.view (see listMovements)
        metadata: { kind: input.kind, quantity, valuation },
      }),
    );
    return {
      id: movement.id,
      metadata: { kind: input.kind, quantity, ...valuation },
    };
  }

  /**
   * Stock aging: days since each variant was last received at each location
   * (purchase receipts; else its first arrival there), with bucket totals
   */
  async aging(tenantId: string, query: AgingQueryDto) {
    const params: unknown[] = [tenantId];
    const where: string[] = [
      'l."tenantId" = $1',
      'l."quantityOnHand" > 0',
      `loc."stockStatus" <> 'transit'`,
    ];
    if (query.locationId) {
      params.push(query.locationId);
      where.push(`l."locationId" = $${params.length}`);
    }
    if (query.search) {
      params.push(containsPattern(query.search));
      where.push(
        `(v.sku ILIKE $${params.length} OR p.name::text ILIKE $${params.length})`,
      );
    }
    // Branch-limited users: their branches' locations only (spec §9)
    const branches = scopedBranchIds();
    if (branches) {
      params.push(branches);
      where.push(
        `l."locationId" IN ${branchLocationIdsSql(`$${params.length}`, '$1')}`,
      );
    }
    const rows = await this.dataSource.query<
      {
        variantId: string;
        locationId: string;
        sku: string;
        productName: Record<string, string>;
        variantName: Record<string, string> | null;
        locationCode: string;
        locationName: string | null;
        stockStatus: string;
        quantityOnHand: number;
        cost: string | null;
        lastReceivedAt: Date | null;
        firstInAt: Date | null;
      }[]
    >(
      `SELECT l."variantId", l."locationId", v.sku, p.name AS "productName",
              v.name AS "variantName", loc.code AS "locationCode",
              loc.name AS "locationName", loc."stockStatus",
              l."quantityOnHand", v.cost,
              COALESCE(r.last_receipt, l."lastReceivedAt") AS "lastReceivedAt",
              f.first_in AS "firstInAt"
         FROM stock_levels l
         JOIN product_variants v ON v.id = l."variantId"
         JOIN products p ON p.id = v."productId"
         JOIN inventory_locations loc ON loc.id = l."locationId"
         LEFT JOIN LATERAL (
           SELECT MAX(m."movementDate") AS last_receipt FROM stock_movements m
            WHERE m."tenantId" = l."tenantId" AND m."variantId" = l."variantId"
              AND m."toLocationId" = l."locationId" AND m."movementType" = 'purchase'
         ) r ON true
         LEFT JOIN LATERAL (
           SELECT MIN(m."movementDate") AS first_in FROM stock_movements m
            WHERE m."tenantId" = l."tenantId" AND m."variantId" = l."variantId"
              AND m."toLocationId" = l."locationId"
         ) f ON true
        WHERE ${where.join(' AND ')}
        LIMIT 5000`,
      params,
    );
    const now = new Date();
    const items = rows
      .map((row) => {
        const since = row.lastReceivedAt ?? row.firstInAt;
        const days = daysSince(since, now);
        const cost = row.cost === null ? null : Number(row.cost);
        return {
          variantId: row.variantId,
          locationId: row.locationId,
          sku: row.sku,
          productName: row.productName,
          variantName: row.variantName,
          locationCode: row.locationCode,
          locationName: row.locationName,
          stockStatus: row.stockStatus,
          quantityOnHand: Number(row.quantityOnHand),
          lastReceivedAt: row.lastReceivedAt,
          // No purchase receipt: the first time it came into the location
          agedFrom: since,
          days,
          bucket: agingBucket(days),
          stockValue:
            cost === null ? null : round4(cost * Number(row.quantityOnHand)),
        };
      })
      .filter(
        (row) =>
          query.minDays === undefined ||
          (row.days ?? Infinity) >= query.minDays,
      )
      .sort((a, b) => (b.days ?? Infinity) - (a.days ?? Infinity));

    const buckets = [
      ...AGING_BUCKETS.map((b) => b.key),
      'unknown' as const,
    ].map((key) => {
      const inBucket = items.filter((i) => i.bucket === key);
      return {
        key,
        lines: inBucket.length,
        quantity: sumQty(inBucket.map((i) => i.quantityOnHand)),
        stockValue: round4(
          inBucket.reduce((sum, i) => sum + (i.stockValue ?? 0), 0),
        ),
      };
    });
    return { generatedAt: now, buckets, items: items.slice(0, 2000) };
  }

  async listMovements(tenantId: string, query: MovementsQueryDto) {
    const qb = this.movementRepository
      .createQueryBuilder('movement')
      .leftJoinAndSelect('movement.variant', 'variant')
      .leftJoinAndSelect('variant.product', 'product')
      .where('movement.tenantId = :tenantId', { tenantId })
      .orderBy('movement.movementDate', 'DESC')
      .take(Math.min(query.limit ?? 100, 500));

    if (query.variantId) {
      qb.andWhere('movement.variantId = :variantId', {
        variantId: query.variantId,
      });
    }
    if (query.locationId) {
      qb.andWhere(
        '(movement.fromLocationId = :locationId OR movement.toLocationId = :locationId)',
        {
          locationId: query.locationId,
        },
      );
    }
    // Branch-limited users: movements in or out of their branches' locations
    const from = locationFilterSql('"movement"."fromLocationId"');
    const to = locationFilterSql('"movement"."toLocationId"');
    if (from && to) {
      qb.andWhere(`(${from.sql} OR ${to.sql})`, { ...from.params });
    }
    const movements = await qb.getMany();
    // Revaluation entries carry costs in metadata.valuation
    if (hiddenFieldsFor(requestContext.get()?.permissions).has('cost')) {
      for (const movement of movements) {
        if (movement.metadata?.valuation) {
          const { valuation: _hidden, ...rest } = movement.metadata;
          void _hidden;
          movement.metadata = rest;
        }
      }
    }
    return movements;
  }

  private async assertLocation(tenantId: string, locationId: string) {
    const exists = await this.dataSource
      .getRepository(InventoryLocation)
      .exists({ where: { id: locationId, tenantId } });
    if (!exists) {
      throw new NotFoundException('Location not found');
    }
    // Stock of another branch's locations is not visible nor movable (spec §9)
    await assertLocationAccess(this.dataSource.manager, tenantId, locationId);
  }

  private async assertVariants(tenantId: string, variantIds: string[]) {
    const unique = [...new Set(variantIds)];
    if (unique.length !== variantIds.length) {
      throw new BadRequestException('Each variant can only appear once');
    }
    const count = await this.dataSource
      .getRepository(ProductVariant)
      .count({ where: { tenantId, id: In(unique) } });
    if (count !== unique.length) {
      throw new NotFoundException('One or more variants were not found');
    }
  }
}
