import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { assertUnitQuantities } from '../products/variant-units';
import {
  assertLocationAccess,
  canAccessLocation,
  locationFilterSql,
} from '../auth/branch-scope';
import {
  StockCount,
  StockCountStatus,
} from '../database/entities/stock-count.entity';
import { StockCountItem } from '../database/entities/stock-count-item.entity';
import { InventoryLocation } from '../database/entities/inventory-location.entity';
import { MovementType } from '../database/entities/stock-movement.entity';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { nextDocumentNumber } from '../common/utils/sequence';
import { OutboxService } from '../platform/outbox/outbox.service';
import { InventoryService } from './inventory.service';
import {
  CountMovement,
  expectedAtCount,
  lineVariance,
  movementsBetween,
  needsApproval,
  summarizeCount,
} from './stock-count.logic';
import {
  CreateStockCountDto,
  EnterCountsDto,
  StockCountsQueryDto,
} from './inventory.dto';

const MAX_COUNT_LINES = 5000;

const OPEN_STATUSES = [
  StockCountStatus.IN_PROGRESS,
  StockCountStatus.PENDING_APPROVAL,
];

/**
 * Stock count sessions (R065): snapshot → count → review → post RECOUNT
 * adjustments, with approval when a variance is above the tolerance.
 */
@Injectable()
export class StockCountsService {
  constructor(
    private dataSource: DataSource,
    private inventoryService: InventoryService,
    private settingsService: SettingsService,
    private auditService: AuditService,
    // Domain events (stock.count.posted); optional for unit tests
    @Optional() private outbox?: OutboxService,
  ) {}

  async list(tenantId: string, query: StockCountsQueryDto) {
    const qb = this.dataSource
      .getRepository(StockCount)
      .createQueryBuilder('count')
      .leftJoinAndSelect('count.location', 'location')
      .where('count.tenantId = :tenantId', { tenantId })
      .orderBy('count.created_at', 'DESC')
      .take(200);
    if (query.status) {
      qb.andWhere('count.status = :status', { status: query.status });
    }
    if (query.locationId) {
      qb.andWhere('count.locationId = :locationId', {
        locationId: query.locationId,
      });
    }
    // Branch-limited users: counts at their branches' locations (spec §9)
    const scope = locationFilterSql('"count"."locationId"');
    if (scope) qb.andWhere(scope.sql, scope.params);
    const counts = await qb.getMany();
    if (counts.length === 0) return [];
    const stats = await this.dataSource.query<
      { countId: string; lines: number; counted: number }[]
    >(
      `SELECT "countId", COUNT(*)::int AS lines, COUNT("countedQuantity")::int AS counted
         FROM stock_count_items WHERE "tenantId" = $1 AND "countId" = ANY($2::uuid[])
        GROUP BY "countId"`,
      [tenantId, counts.map((c) => c.id)],
    );
    const byId = new Map(stats.map((row) => [row.countId, row]));
    return counts.map((count) => ({
      ...count,
      lineCount: byId.get(count.id)?.lines ?? 0,
      countedCount: byId.get(count.id)?.counted ?? 0,
    }));
  }

  /**
   * A count with its lines. Blind counts hide expected quantities and variances
   * while counting is in progress.
   */
  async get(tenantId: string, id: string) {
    const count = await this.dataSource.getRepository(StockCount).findOne({
      where: { tenantId, id },
      relations: { location: true },
    });
    if (
      !count ||
      !(await canAccessLocation(
        this.dataSource.manager,
        tenantId,
        count.locationId,
      ))
    ) {
      throw new NotFoundException('Stock count not found');
    }

    const rows = await this.dataSource
      .getRepository(StockCountItem)
      .createQueryBuilder('item')
      .innerJoin('item.variant', 'variant')
      .innerJoin('variant.product', 'product')
      .select([
        'item.id AS id',
        'item.variantId AS "variantId"',
        'variant.sku AS sku',
        'variant.barcode AS barcode',
        'variant.name AS "variantName"',
        'product.name AS "productName"',
        'item.expectedQuantity AS "expectedQuantity"',
        'item.movementsSinceSnapshot AS "movementsSinceSnapshot"',
        'item.countedQuantity AS "countedQuantity"',
        'item.variance AS variance',
        'item.reason AS reason',
        'item.unitCost AS "unitCost"',
        'item.countedAt AS "countedAt"',
      ])
      .where('item.tenantId = :tenantId AND item.countId = :id', {
        tenantId,
        id,
      })
      .orderBy('product.name', 'ASC')
      .addOrderBy('variant.sku', 'ASC')
      .getRawMany<{
        expectedQuantity: number | null;
        movementsSinceSnapshot: number | null;
        countedQuantity: number | null;
        variance: number | null;
        unitCost: number | null;
      }>();

    const hideExpected =
      count.blind && count.status === StockCountStatus.IN_PROGRESS;
    // Roll-forward shown per line: snapshot + movements while counting = expected at count
    const withRollForward = rows.map((r) => ({
      ...r,
      expectedAtCount:
        r.movementsSinceSnapshot === null
          ? null
          : expectedAtCount({
              expectedQuantity: Number(r.expectedQuantity),
              movementsSinceSnapshot: r.movementsSinceSnapshot,
              countedQuantity: r.countedQuantity,
            }),
    }));
    const items = hideExpected
      ? withRollForward.map((r) => ({
          ...r,
          expectedQuantity: null,
          movementsSinceSnapshot: null,
          expectedAtCount: null,
          variance: null,
        }))
      : withRollForward;
    const summary = hideExpected
      ? null
      : summarizeCount(
          rows.map((r) => ({
            expectedQuantity: Number(r.expectedQuantity),
            movementsSinceSnapshot: r.movementsSinceSnapshot,
            countedQuantity: r.countedQuantity,
            unitCost: r.unitCost,
          })),
        );
    return { ...count, expectedHidden: hideExpected, items, summary };
  }

  /**
   * Start a session: snapshot the expected on-hand quantities
   */
  async create(tenantId: string, userId: string, dto: CreateStockCountDto) {
    const location = await this.dataSource
      .getRepository(InventoryLocation)
      .findOne({ where: { tenantId, id: dto.locationId } });
    if (!location) throw new NotFoundException('Location not found');
    await assertLocationAccess(this.dataSource.manager, tenantId, location.id);

    const qb = this.dataSource
      .createQueryBuilder()
      .select('variant.id', 'variantId')
      .addSelect('COALESCE(level.quantityOnHand, 0)', 'onHand')
      .from('product_variants', 'variant')
      .innerJoin('products', 'product', 'product.id = variant."productId"')
      .leftJoin(
        'stock_levels',
        'level',
        'level."variantId" = variant.id AND level."locationId" = :locationId',
        { locationId: dto.locationId },
      )
      .where('variant."tenantId" = :tenantId', { tenantId })
      .andWhere("variant.status != 'discontinued'")
      .limit(MAX_COUNT_LINES + 1);
    if (dto.categoryId) {
      qb.innerJoin(
        'categories',
        'category',
        'category.id = product."categoryId"',
      )
        .andWhere(
          `category.mpath LIKE (SELECT c.mpath FROM categories c WHERE c.id = :categoryId AND c."tenantId" = :tenantId) || '%'`,
        )
        .setParameter('categoryId', dto.categoryId);
    }
    if (dto.variantIds?.length) {
      qb.andWhere('variant.id IN (:...variantIds)', {
        variantIds: dto.variantIds,
      });
    }
    // Database clock, like movementDate: movements after it roll the count forward
    const [{ now: snapshotAt }] = await this.dataSource.query<{ now: Date }[]>(
      'SELECT clock_timestamp() AS now',
    );
    const snapshot = await qb.getRawMany<{
      variantId: string;
      onHand: number;
    }>();
    if (snapshot.length === 0) {
      throw new BadRequestException('No products match this count');
    }
    if (snapshot.length > MAX_COUNT_LINES) {
      throw new BadRequestException(
        `A count can have at most ${MAX_COUNT_LINES} lines; count by category instead`,
      );
    }

    const id = await this.dataSource.transaction(async (manager) => {
      const countNumber = await nextDocumentNumber(manager, {
        table: 'stock_counts',
        column: 'countNumber',
        tenantId,
        prefix: 'CNT',
      });
      const count = await manager.save(
        manager.create(StockCount, {
          tenantId,
          countNumber,
          locationId: dto.locationId,
          categoryId: dto.categoryId ?? null,
          blind: dto.blind ?? false,
          notes: dto.notes ?? null,
          snapshotAt,
          createdById: userId,
          status: StockCountStatus.IN_PROGRESS,
        }),
      );
      for (let i = 0; i < snapshot.length; i += 500) {
        await manager.insert(
          StockCountItem,
          snapshot.slice(i, i + 500).map((row) => ({
            tenantId,
            countId: count.id,
            variantId: row.variantId,
            expectedQuantity: Number(row.onHand),
          })),
        );
      }
      await this.auditService.record(
        {
          tenantId,
          action: 'inventory.count_started',
          entityType: 'stock_count',
          entityId: count.id,
          metadata: {
            countNumber,
            locationId: dto.locationId,
            categoryId: dto.categoryId ?? null,
            blind: count.blind,
            lines: snapshot.length,
          },
        },
        manager,
      );
      return count.id;
    });
    return this.get(tenantId, id);
  }

  /**
   * Record counted quantities (partial saves allowed while in progress)
   */
  async enterCounts(tenantId: string, id: string, dto: EnterCountsDto) {
    await this.dataSource.transaction(async (manager) => {
      await this.lockCount(manager, tenantId, id, [
        StockCountStatus.IN_PROGRESS,
      ]);
      const variantIds = dto.items.map((i) => i.variantId);
      if (new Set(variantIds).size !== variantIds.length) {
        throw new BadRequestException('Each variant can only appear once');
      }
      const existing = await manager.count(StockCountItem, {
        where: { tenantId, countId: id, variantId: In(variantIds) },
      });
      if (existing !== variantIds.length) {
        throw new BadRequestException(
          'One or more variants are not part of this count',
        );
      }
      // Decimals only for measured items, up to their unit's precision
      await assertUnitQuantities(
        manager,
        tenantId,
        dto.items.map((i) => ({
          variantId: i.variantId,
          quantity: i.countedQuantity,
        })),
        { allowZero: true },
      );
      for (const entry of dto.items) {
        await manager.update(
          StockCountItem,
          { tenantId, countId: id, variantId: entry.variantId },
          {
            countedQuantity: entry.countedQuantity,
            // Database clock (as movementDate) for the roll-forward
            countedAt: entry.countedQuantity === null ? null : () => 'NOW()',
            ...(entry.reason !== undefined && {
              reason: entry.reason?.trim() || null,
            }),
          },
        );
      }
    });
    return this.get(tenantId, id);
  }

  /**
   * Finish counting: compute variances. Within tolerance → posted now;
   * otherwise it waits for inventory.count.approve.
   */
  async submit(tenantId: string, id: string, userId: string) {
    const { countVarianceTolerance } =
      await this.settingsService.getSettings(tenantId);
    await this.dataSource.transaction(async (manager) => {
      const count = await this.lockCount(manager, tenantId, id, [
        StockCountStatus.IN_PROGRESS,
      ]);
      const items = await manager.find(StockCountItem, {
        where: { tenantId, countId: id },
        relations: { variant: true },
      });
      if (!items.some((i) => i.countedQuantity !== null)) {
        throw new BadRequestException('Nothing has been counted yet');
      }
      await this.rollForward(manager, count, items);
      for (const item of items) {
        item.unitCost =
          item.variant?.cost === null || item.variant?.cost === undefined
            ? null
            : Number(item.variant.cost);
        await manager.update(
          StockCountItem,
          { id: item.id, tenantId },
          { unitCost: item.unitCost },
        );
      }
      count.submittedById = userId;
      count.submittedAt = new Date();
      const approval = needsApproval(items, countVarianceTolerance);
      const summary = summarizeCount(items);
      await this.auditService.record(
        {
          tenantId,
          action: 'inventory.count_submitted',
          entityType: 'stock_count',
          entityId: count.id,
          metadata: {
            countNumber: count.countNumber,
            tolerance: countVarianceTolerance,
            needsApproval: approval,
            summary,
          },
        },
        manager,
      );
      if (approval) {
        count.status = StockCountStatus.PENDING_APPROVAL;
        await manager.save(count);
      } else {
        await this.post(manager, count, items, userId, null);
      }
    });
    return this.get(tenantId, id);
  }

  /**
   * Approve variances above the tolerance and post. `approverId` has been
   * checked to differ from the counter (see resolveDistinctApprover).
   */
  async approve(
    tenantId: string,
    id: string,
    userId: string,
    approverId: string,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const count = await this.lockCount(manager, tenantId, id, [
        StockCountStatus.PENDING_APPROVAL,
      ]);
      if (approverId === count.submittedById) {
        throw new BadRequestException(
          'Count variances must be approved by someone other than the counter',
        );
      }
      const items = await manager.find(StockCountItem, {
        where: { tenantId, countId: id },
      });
      count.approvedById = approverId;
      count.approvedAt = new Date();
      await this.post(manager, count, items, userId, approverId);
    });
    return this.get(tenantId, id);
  }

  /**
   * Send a submitted count back for recounting
   */
  async reject(tenantId: string, id: string, reason?: string) {
    await this.dataSource.transaction(async (manager) => {
      const count = await this.lockCount(manager, tenantId, id, [
        StockCountStatus.PENDING_APPROVAL,
      ]);
      count.status = StockCountStatus.IN_PROGRESS;
      count.submittedAt = null;
      await manager.save(count);
      await manager.update(
        StockCountItem,
        { tenantId, countId: id },
        { variance: null, movementsSinceSnapshot: null },
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'inventory.count_rejected',
          entityType: 'stock_count',
          entityId: id,
          reason: reason ?? null,
          metadata: { countNumber: count.countNumber },
        },
        manager,
      );
    });
    return this.get(tenantId, id);
  }

  async cancel(tenantId: string, id: string, reason?: string) {
    await this.dataSource.transaction(async (manager) => {
      const count = await this.lockCount(manager, tenantId, id, OPEN_STATUSES);
      count.status = StockCountStatus.CANCELLED;
      count.cancelledAt = new Date();
      await manager.save(count);
      await this.auditService.record(
        {
          tenantId,
          action: 'inventory.count_cancelled',
          entityType: 'stock_count',
          entityId: id,
          reason: reason ?? null,
          metadata: { countNumber: count.countNumber },
        },
        manager,
      );
    });
    return this.get(tenantId, id);
  }

  /**
   * Roll-forward: store per line the net movements at the location between the
   * snapshot and when it was counted, and the variance against snapshot + those
   * movements (a sale made while counting is not a variance). Run at
   * submission and again at posting.
   */
  private async rollForward(
    manager: EntityManager,
    count: StockCount,
    items: StockCountItem[],
  ) {
    const counted = items.filter((i) => i.countedQuantity !== null);
    const movements = counted.length
      ? await manager.query<CountMovement[]>(
          `SELECT "variantId",
                  CASE WHEN "toLocationId" = $2 THEN quantity ELSE -quantity END AS quantity,
                  "movementDate"
             FROM stock_movements
            WHERE "tenantId" = $1
              AND ("toLocationId" = $2 OR "fromLocationId" = $2)
              AND "movementDate" > $3
              AND NOT ("referenceType" = 'stock_count' AND "referenceId" = $4)
              AND "variantId" = ANY($5::uuid[])`,
          [
            count.tenantId,
            count.locationId,
            count.snapshotAt ?? count.createdAt,
            count.id,
            counted.map((i) => i.variantId),
          ],
        )
      : [];
    const net = movementsBetween(
      count.snapshotAt ?? count.createdAt,
      counted,
      (Array.isArray(movements) ? movements : []).map((m) => ({
        ...m,
        quantity: Number(m.quantity),
      })),
    );
    for (const item of items) {
      item.movementsSinceSnapshot =
        item.countedQuantity === null ? null : (net.get(item.variantId) ?? 0);
      item.variance = lineVariance(item);
      await manager.update(
        StockCountItem,
        { id: item.id, tenantId: count.tenantId },
        {
          movementsSinceSnapshot: item.movementsSinceSnapshot,
          variance: item.variance,
        },
      );
    }
  }

  /**
   * Post the counted lines as RECOUNT movements: delta = counted − (snapshot +
   * movements until the line was counted), so movements made while counting
   * are kept and not mistaken for variances. All in the caller's transaction.
   */
  private async post(
    manager: EntityManager,
    count: StockCount,
    items: StockCountItem[],
    userId: string,
    approverId: string | null,
  ) {
    await this.rollForward(manager, count, items);
    const posted: {
      variantId: string;
      variance: number;
      reason: string | null;
    }[] = [];
    for (const item of items) {
      const variance = lineVariance(item);
      if (variance === null) continue;
      await this.inventoryService.applyMovement(manager, {
        tenantId: count.tenantId,
        userId,
        variantId: item.variantId,
        locationId: count.locationId,
        delta: variance,
        movementType: MovementType.RECOUNT,
        referenceType: 'stock_count',
        referenceId: count.id,
        referenceNumber: count.countNumber,
        notes: item.reason ?? count.notes ?? undefined,
        // D018: on hand never below zero; a count corrects on hand, so
        // reservations don't block it
        respectReservations: false,
        metadata: {
          expectedQuantity: item.expectedQuantity,
          movementsSinceSnapshot: item.movementsSinceSnapshot ?? 0,
          countedQuantity: item.countedQuantity,
        },
      });
      posted.push({
        variantId: item.variantId,
        variance,
        reason: item.reason ?? null,
      });
    }
    count.status = StockCountStatus.POSTED;
    count.postedAt = new Date();
    await manager.save(count);
    await this.auditService.record(
      {
        tenantId: count.tenantId,
        action: 'inventory.count_posted',
        entityType: 'stock_count',
        entityId: count.id,
        approverId: approverId ?? undefined,
        metadata: {
          countNumber: count.countNumber,
          locationId: count.locationId,
          summary: summarizeCount(items),
          adjustments: posted.filter((p) => p.variance !== 0),
        },
      },
      manager,
    );
    await this.outbox?.record(manager, {
      tenantId: count.tenantId,
      type: 'stock.count.posted',
      aggregateId: count.id,
      payload: {
        countId: count.id,
        countNumber: count.countNumber,
        locationId: count.locationId,
        approverId: approverId ?? null,
        adjustments: posted.filter((p) => p.variance !== 0),
      },
    });
  }

  private async lockCount(
    manager: EntityManager,
    tenantId: string,
    id: string,
    allowed: StockCountStatus[],
  ): Promise<StockCount> {
    const count = await manager.findOne(StockCount, {
      where: { tenantId, id },
      lock: { mode: 'pessimistic_write' },
    });
    if (
      !count ||
      !(await canAccessLocation(manager, tenantId, count.locationId))
    ) {
      throw new NotFoundException('Stock count not found');
    }
    if (!allowed.includes(count.status)) {
      throw new BadRequestException(
        `This count is ${count.status.replace('_', ' ')}`,
      );
    }
    return count;
  }
}
