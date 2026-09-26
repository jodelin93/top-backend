import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { SettingsService } from '../settings/settings.service';
import { EventHandlerRegistry } from '../platform/outbox/event-handler.registry';
import {
  activeTenantIds,
  errorMessage,
  LOCKS,
  runExclusive,
} from '../platform/scheduling';
import { registerBranchId } from '../auth/branch-scope';
import { NotificationsService } from './notifications.service';
import type { NotificationType } from './notification-rules';

// How often the scheduled checks run (NOTIFICATION_CHECK_MS, default 5 min)
const DEFAULT_CHECK_MS = 5 * 60_000;
// Card payments still unresolved after this need a person (spec §15)
export const UNRESOLVED_PAYMENT_AFTER_MINUTES = 15;
// A device with queued sales that has not synced for this long is flagged
export const UNSYNCED_DEVICE_AFTER_MINUTES = 30;
// Items listed in a low stock notification body
const LOW_STOCK_LISTED = 10;

export interface LowStockItem {
  variantId: string;
  sku: string;
  productName: string;
  locationId: string;
  locationName: string;
  available: number;
  threshold: number;
}

type Queryable = Pick<EntityManager, 'query'> | Pick<DataSource, 'query'>;

/** Stock levels at or below their minimum (the variant's, else the store's low stock threshold) */
export async function findLowStock(
  db: Queryable,
  tenantId: string,
  storeThreshold: number,
  options: { locationId?: string; variantId?: string } = {},
): Promise<LowStockItem[]> {
  const rows = await db.query<
    {
      variantId: string;
      sku: string | null;
      productName: string | null;
      locationId: string;
      locationName: string | null;
      available: number | string;
      threshold: number | string;
    }[]
  >(
    `SELECT sl."variantId", v.sku, COALESCE(p.name->>'en', v.sku) AS "productName",
            sl."locationId", COALESCE(l.name, '') AS "locationName",
            sl."quantityAvailable" AS available,
            COALESCE(NULLIF(v."minStockLevel", 0), $2::numeric) AS threshold
       FROM stock_levels sl
       JOIN product_variants v ON v.id = sl."variantId"
       JOIN products p ON p.id = v."productId"
       LEFT JOIN inventory_locations l ON l.id = sl."locationId"
      WHERE sl."tenantId" = $1
        AND v.status = 'active'
        AND COALESCE(NULLIF(v."minStockLevel", 0), $2::numeric) > 0
        AND sl."quantityAvailable" <= COALESCE(NULLIF(v."minStockLevel", 0), $2::numeric)
        AND ($3::uuid IS NULL OR sl."locationId" = $3)
        AND ($4::uuid IS NULL OR sl."variantId" = $4)
      ORDER BY sl."locationId", sl."quantityAvailable"
      LIMIT 1000`,
    [
      tenantId,
      Math.max(0, Number(storeThreshold) || 0),
      options.locationId ?? null,
      options.variantId ?? null,
    ],
  );
  return rows.map((r) => ({
    variantId: r.variantId,
    sku: r.sku ?? '',
    productName: r.productName ?? '',
    locationId: r.locationId,
    locationName: r.locationName ?? '',
    available: Number(r.available),
    threshold: Number(r.threshold),
  }));
}

/**
 * Notification generators (spec §15):
 * - outbox consumers: cash variance over tolerance (shift.closed), low stock
 *   (stock.adjusted, once the inventory module emits it);
 * - scheduled checks every NOTIFICATION_CHECK_MS on one instance: pending
 *   approvals, unresolved card payments older than 15 min, unmatched
 *   settlement lines, devices with unsynced sales, low stock per location.
 * A check raises one de-duplicated notification per condition and clears it
 * (closes it) once the condition is gone. Alerts about a branch, register,
 * shift or stock location carry it, so only members working there see them.
 */
@Injectable()
export class NotificationGeneratorsService
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(NotificationGeneratorsService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private dataSource: DataSource,
    private notifications: NotificationsService,
    private settingsService: SettingsService,
    private registry: EventHandlerRegistry,
  ) {}

  onModuleInit() {
    this.registry.register(
      'notifications.shift-variance',
      'shift.closed',
      async (event, manager) => {
        const p = event.payload;
        if (!p.overTolerance) return;
        // Shown to the members of the shift's branch
        const branchId = await registerBranchId(
          manager,
          event.tenantId,
          p.registerId,
        );
        await this.notifications.notify(
          {
            tenantId: event.tenantId,
            type: 'shift.variance',
            title: `Shift ${p.shiftNumber} closed with a cash variance over tolerance`,
            body: `Expected ${p.expected ?? '—'}, counted ${p.counted ?? '—'}, variance ${p.variance ?? '—'} (tolerance ${p.tolerance}).`,
            entityType: 'shift',
            entityId: p.shiftId,
            dedupeKey: `shift.variance:${p.shiftId}`,
            branchId,
          },
          manager,
        );
      },
    );

    this.registry.register(
      'notifications.low-stock',
      'stock.adjusted',
      async (event, manager) => {
        const p = event.payload;
        const { lowStockThreshold } = await this.settingsService.getSettings(
          event.tenantId,
        );
        const key = `stock.low:${p.variantId}:${p.locationId}`;
        const [item] = await findLowStock(
          manager,
          event.tenantId,
          lowStockThreshold,
          { variantId: p.variantId, locationId: p.locationId },
        );
        if (!item) {
          await this.notifications.resolve(event.tenantId, key, manager);
          return;
        }
        await this.notifications.notify(
          {
            tenantId: event.tenantId,
            type: 'stock.low',
            title: `Low stock: ${item.sku}`,
            body: `${item.productName} (${item.sku}) at ${item.locationName}: ${item.available} available, minimum ${item.threshold}.`,
            entityType: 'product_variant',
            entityId: item.variantId,
            dedupeKey: key,
            locationId: item.locationId,
          },
          manager,
        );
      },
    );
  }

  onApplicationBootstrap() {
    if (process.env.NOTIFICATION_CHECKS === 'off') return;
    const interval =
      Number(process.env.NOTIFICATION_CHECK_MS) || DEFAULT_CHECK_MS;
    this.timer = setInterval(() => {
      void this.runScheduled();
    }, interval);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** All checks for every store, on one instance at a time */
  async runScheduled(): Promise<void> {
    try {
      await runExclusive(
        this.dataSource,
        LOCKS.notificationChecks,
        async () => {
          for (const tenantId of await activeTenantIds(this.dataSource)) {
            await this.runChecks(tenantId);
          }
        },
      );
    } catch (error) {
      this.logger.error(`Notification checks failed: ${errorMessage(error)}`);
    }
  }

  /** Every check for one store; a failing check does not stop the others */
  async runChecks(tenantId: string) {
    const checks: [string, () => Promise<void>][] = [
      ['approvals', () => this.checkPendingApprovals(tenantId)],
      ['payments', () => this.checkUnresolvedPayments(tenantId)],
      ['devices', () => this.checkUnsyncedDevices(tenantId)],
      ['low-stock', () => this.checkLowStock(tenantId).then(() => undefined)],
    ];
    const failed: string[] = [];
    for (const [name, check] of checks) {
      try {
        await check();
      } catch (error) {
        failed.push(name);
        this.logger.warn(
          `Check ${name} failed for store ${tenantId}: ${errorMessage(error)}`,
        );
      }
    }
    return { failed };
  }

  /** Raise, or clear when `count` is 0, a summary notification */
  private async summary(
    tenantId: string,
    type: NotificationType,
    count: number,
    title: string,
    body: string | null = null,
    dedupeKey: string = type,
    entity?: {
      entityType: string;
      entityId: string;
      branchId?: string | null;
      locationId?: string | null;
    },
  ) {
    if (count <= 0) {
      await this.notifications.resolve(tenantId, dedupeKey);
      return;
    }
    await this.notifications.notify({
      tenantId,
      type,
      title,
      body,
      dedupeKey,
      ...entity,
    });
  }

  async checkPendingApprovals(tenantId: string) {
    const [row] = await this.dataSource.query<
      { expenses: string; orders: string; counts: string }[]
    >(
      `SELECT
         (SELECT COUNT(*) FROM expenses WHERE "tenantId" = $1 AND status = 'submitted') AS expenses,
         (SELECT COUNT(*) FROM purchase_orders WHERE "tenantId" = $1 AND status = 'pending_approval') AS orders,
         (SELECT COUNT(*) FROM stock_counts WHERE "tenantId" = $1 AND status = 'pending_approval') AS counts`,
      [tenantId],
    );
    const expenses = Number(row?.expenses ?? 0);
    const orders = Number(row?.orders ?? 0);
    const counts = Number(row?.counts ?? 0);
    await this.summary(
      tenantId,
      'approval.expense',
      expenses,
      `${expenses} expense(s) waiting for approval`,
    );
    await this.summary(
      tenantId,
      'approval.purchase_order',
      orders,
      `${orders} purchase order(s) waiting for approval`,
    );
    await this.summary(
      tenantId,
      'approval.stock_count',
      counts,
      `${counts} stock count(s) waiting for approval`,
    );
  }

  async checkUnresolvedPayments(tenantId: string) {
    const [row] = await this.dataSource.query<
      { unresolved: string; unmatched: string }[]
    >(
      `SELECT
         (SELECT COUNT(*) FROM payments p
           WHERE p."tenantId" = $1
             AND p.status IN ('initiated', 'pending', 'authorized', 'unknown')
             AND p."reconciledAt" IS NULL
             AND p.created_at < now() - ($2::int * interval '1 minute')) AS unresolved,
         (SELECT COUNT(*) FROM settlement_lines sl
           WHERE sl."tenantId" = $1 AND sl.status = 'unmatched') AS unmatched`,
      [tenantId, UNRESOLVED_PAYMENT_AFTER_MINUTES],
    );
    const unresolved = Number(row?.unresolved ?? 0);
    const unmatched = Number(row?.unmatched ?? 0);
    // Counts only: no amounts, cards or customers in notifications
    await this.summary(
      tenantId,
      'payment.unresolved',
      unresolved,
      `${unresolved} card payment(s) unresolved for more than ${UNRESOLVED_PAYMENT_AFTER_MINUTES} minutes`,
      'Check them in Card settlements: confirm or cancel each payment with the provider.',
    );
    await this.summary(
      tenantId,
      'payment.settlement_unmatched',
      unmatched,
      `${unmatched} card settlement line(s) not matched to a payment`,
    );
  }

  async checkUnsyncedDevices(tenantId: string) {
    const devices = await this.dataSource.query<
      {
        id: string;
        name: string;
        branchId: string | null;
        pendingSales: number;
        failedSales: number;
        flagged: boolean;
      }[]
    >(
      `SELECT d.id, d.name, reg."branchId", d."pendingSales", d."failedSales",
              (d."failedSales" > 0
               OR (d."pendingSales" > 0
                   AND (d."lastSyncAt" IS NULL OR d."lastSyncAt" < now() - ($2::int * interval '1 minute')))) AS flagged
         FROM devices d
         LEFT JOIN registers reg ON reg.id = d."registerId"
        WHERE d."tenantId" = $1 AND d."revokedAt" IS NULL`,
      [tenantId, UNSYNCED_DEVICE_AFTER_MINUTES],
    );
    for (const device of devices) {
      await this.summary(
        tenantId,
        'device.unsynced',
        device.flagged ? 1 : 0,
        `Device ${device.name} has sales that did not reach the server`,
        `${device.pendingSales} queued, ${device.failedSales} failed.`,
        `device.unsynced:${device.id}`,
        // The register's branch; a device without a register: every-branch members
        {
          entityType: 'device',
          entityId: device.id,
          branchId: device.branchId,
        },
      );
    }
  }

  /** One notification per location with low stock; returns the items found */
  async checkLowStock(tenantId: string, locationId?: string) {
    const { lowStockThreshold } =
      await this.settingsService.getSettings(tenantId);
    const items = await findLowStock(
      this.dataSource,
      tenantId,
      lowStockThreshold,
      { locationId },
    );
    const byLocation = new Map<string, LowStockItem[]>();
    for (const item of items) {
      byLocation.set(item.locationId, [
        ...(byLocation.get(item.locationId) ?? []),
        item,
      ]);
    }
    for (const [location, list] of byLocation) {
      const listed = list
        .slice(0, LOW_STOCK_LISTED)
        .map(
          (i) =>
            `${i.sku} ${i.productName}: ${i.available} (min ${i.threshold})`,
        );
      if (list.length > LOW_STOCK_LISTED) {
        listed.push(`… and ${list.length - LOW_STOCK_LISTED} more`);
      }
      await this.summary(
        tenantId,
        'stock.low',
        list.length,
        `${list.length} item(s) low on stock at ${list[0].locationName || 'a location'}`,
        listed.join('\n'),
        `stock.low:${location}`,
        {
          entityType: 'inventory_location',
          entityId: location,
          locationId: location,
        },
      );
    }
    // Locations back above their minimums
    const open = await this.dataSource.query<{ dedupeKey: string }[]>(
      `SELECT "dedupeKey" FROM notifications
        WHERE "tenantId" = $1 AND type = 'stock.low' AND "readAt" IS NULL
          AND "entityType" = 'inventory_location'
          AND ($2::uuid IS NULL OR "entityId" = $2::text)`,
      [tenantId, locationId ?? null],
    );
    for (const { dedupeKey } of open) {
      const location = dedupeKey.split(':')[1];
      if (location && !byLocation.has(location)) {
        await this.notifications.resolve(tenantId, dedupeKey);
      }
    }
    return items;
  }
}
