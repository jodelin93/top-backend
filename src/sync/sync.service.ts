import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { assertBranchAccess, branchWhere } from '../auth/branch-scope';
import { Register, RegisterStatus } from '../database/entities/register.entity';
import {
  PaymentMethod,
  PaymentMethodStatus,
} from '../database/entities/payment-method.entity';
import { Category } from '../database/entities/category.entity';
import { Customer, CustomerStatus } from '../database/entities/customer.entity';
import { SettingsService } from '../settings/settings.service';
import { CatalogItem, PosService } from '../sales/pos.service';
import { offlineSyncEventsTotal } from '../metrics/metrics.registry';
import {
  advanceCursor,
  CHANGE_LOG_RETENTION,
  ChangeRow,
  collectChanges,
  decodeCursor,
  encodeCursor,
  ResetReason,
  resetReasonFor,
  SyncCursor,
} from './sync-cursor';

export type { ResetReason } from './sync-cursor';

// Same shape as GET /pos/catalog items
export type SyncCatalogItem = CatalogItem;

export interface SyncCustomer {
  id: string;
  code: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  // No email / phone: every till would hold them (the POS looks customers up online)
  loyaltyPoints: number;
}

export interface SyncChanges {
  cursor: string;
  // Another page is waiting: call again with the new cursor right away
  hasMore: boolean;
  // Download everything (GET /pos/context + /pos/catalog), then continue from `cursor`
  reset: boolean;
  resetReason: ResetReason | null;
  serverTime: string;
  items: SyncCatalogItem[];
  // Tombstones: variants deleted, deactivated or no longer sold at the register's branch
  removedVariantIds: string[];
  customers: SyncCustomer[];
  removedCustomerIds: string[];
  // Full POS context when any of it changed, else null
  context: Record<string, unknown> | null;
}

const DEFAULT_LIMIT = 500;
// Rows of transactions still running at the previous read, re-read at most
const MAX_REPLAY = 5000;

// timestamptz → UTC text with microseconds
const ts = (expr: string) =>
  `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly settingsService: SettingsService,
    private readonly posService: PosService,
  ) {}

  async changes(
    tenantId: string,
    query: { cursor?: string; registerId?: string; limit?: number },
  ): Promise<SyncChanges> {
    // Applies any scheduled settings change that is due (logged as a change)
    await this.settingsService.getSettings(tenantId);
    const register = query.registerId
      ? await this.dataSource.getRepository(Register).findOne({
          where: { id: query.registerId, tenantId },
        })
      : null;
    // An unknown id (e.g. another store's register) is refused, not treated as
    // "no register" (tenant isolation); another branch's till is not synced (§9)
    if (query.registerId && !register) {
      throw new NotFoundException('Register not found');
    }
    if (register)
      assertBranchAccess(null, register.branchId, 'Register not found');
    const registerId = register?.id ?? null;
    const branchId = register?.branchId ?? null;
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), 2000);

    // One snapshot for the boundary and every log read (consistent page)
    const read = await this.dataSource.transaction(
      'REPEATABLE READ',
      async (manager) => {
        const [snap] = await manager.query<
          { xmin: string; now: string; maxSeq: string }[]
        >(
          `SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS "xmin",
                  ${ts('clock_timestamp()')} AS "now",
                  COALESCE((SELECT max(seq) FROM sync_change_log WHERE "tenantId" = $1), 0)::text AS "maxSeq"`,
          [tenantId],
        );
        const cursor = decodeCursor(query.cursor);
        const resetReason = resetReasonFor(query.cursor, cursor, {
          now: snap.now,
          registerId,
          branchId,
        });
        if (resetReason || !cursor) {
          return { snap, cursor: null, resetReason, rows: [], full: false };
        }
        const replay = await this.logRows(
          manager,
          `seq <= $2::bigint AND txid >= $3::xid8`,
          [tenantId, cursor.s, cursor.x],
          MAX_REPLAY + 1,
        );
        if (replay.length > MAX_REPLAY) {
          return {
            snap,
            cursor: null,
            resetReason: 'too_many_changes' as const,
            rows: [],
            full: false,
          };
        }
        const fresh = await this.logRows(
          manager,
          `seq > $2::bigint`,
          [tenantId, cursor.s],
          limit + 1,
        );
        const full = fresh.length > limit;
        return {
          snap,
          cursor,
          resetReason: null,
          rows: [...replay, ...fresh.slice(0, limit)],
          lastSeq: fresh.length
            ? fresh[Math.min(fresh.length, limit) - 1].seq
            : null,
          full,
        };
      },
    );

    const { snap } = read;
    const freshCursor = (): SyncCursor => ({
      v: 2,
      s: snap.maxSeq,
      x: snap.xmin,
      r: registerId,
      b: branchId,
      at: snap.now,
    });
    const reset = (reason: ResetReason): SyncChanges => {
      offlineSyncEventsTotal.inc({ event: 'full_resync' });
      void this.pruneLog(tenantId);
      return {
        cursor: encodeCursor(freshCursor()),
        hasMore: false,
        reset: true,
        resetReason: reason,
        serverTime: snap.now,
        items: [],
        removedVariantIds: [],
        customers: [],
        removedCustomerIds: [],
        context: null,
      };
    };

    if (read.resetReason || !read.cursor) {
      return reset(read.resetReason ?? 'invalid_cursor');
    }

    const changes = collectChanges(
      read.rows,
      register?.defaultLocationId ?? null,
    );
    // Prices of every variant may have moved: the till downloads everything
    if (changes.priceListsChanged) return reset('price_lists_changed');

    const productVariantIds = changes.productIds.length
      ? (
          await this.dataSource.query<{ id: string }[]>(
            `SELECT id FROM product_variants WHERE "tenantId" = $1 AND "productId" = ANY($2::uuid[])`,
            [tenantId, changes.productIds],
          )
        ).map((r) => r.id)
      : [];
    const variantIds = [
      ...new Set([...changes.variantIds, ...productVariantIds]),
    ].filter((id) => !changes.deletedVariantIds.includes(id));
    const items = await this.posService.catalogItemsFor(
      tenantId,
      variantIds,
      register,
    );
    const sellable = new Set(items.map((i) => i.variantId));

    const customerRows = changes.customerIds.length
      ? await this.dataSource.getRepository(Customer).find({
          where: { tenantId, id: In(changes.customerIds) },
        })
      : [];
    const activeCustomers = customerRows.filter(
      (c) => c.status === CustomerStatus.ACTIVE,
    );
    const activeIds = new Set(activeCustomers.map((c) => c.id));

    const context = changes.contextChanged
      ? await this.context(tenantId)
      : null;

    offlineSyncEventsTotal.inc({ event: 'changes_served' });
    return {
      cursor: encodeCursor(
        advanceCursor(read.cursor, {
          lastSeq: read.lastSeq ?? null,
          xmin: snap.xmin,
          now: snap.now,
        }),
      ),
      hasMore: read.full,
      reset: false,
      resetReason: null,
      serverTime: snap.now,
      items,
      removedVariantIds: [
        ...new Set([
          ...changes.deletedVariantIds,
          ...variantIds.filter((id) => !sellable.has(id)),
        ]),
      ],
      customers: activeCustomers.map((c) => ({
        id: c.id,
        code: c.code,
        firstName: c.firstName ?? null,
        lastName: c.lastName ?? null,
        companyName: c.companyName ?? null,
        loyaltyPoints: Number(c.loyaltyPoints ?? 0),
      })),
      removedCustomerIds: [
        ...new Set([
          ...changes.deletedCustomerIds,
          ...changes.customerIds.filter((id) => !activeIds.has(id)),
        ]),
      ],
      context,
    };
  }

  private logRows(
    manager: EntityManager,
    where: string,
    params: unknown[],
    take: number,
  ): Promise<ChangeRow[]> {
    return manager.query<ChangeRow[]>(
      `SELECT seq::text AS seq, entity, "entityId", op, scope
         FROM sync_change_log
        WHERE "tenantId" = $1 AND ${where}
        ORDER BY seq
        LIMIT ${Number(take)}`,
      params,
    );
  }

  /** Drop change-log rows older than any cursor still accepted. */
  private async pruneLog(tenantId: string) {
    try {
      await this.dataSource.query(
        `DELETE FROM sync_change_log WHERE "tenantId" = $1 AND changed_at < now() - interval '${CHANGE_LOG_RETENTION}'`,
        [tenantId],
      );
    } catch (err) {
      this.logger.warn(`Change log prune failed: ${String(err)}`);
    }
  }

  /** Same shape as GET /pos/context. */
  private async context(tenantId: string) {
    const [settings, taxRate, registers, paymentMethods, categories] =
      await Promise.all([
        this.settingsService.getSettings(tenantId),
        this.settingsService.getDefaultTaxRate(tenantId),
        this.dataSource.getRepository(Register).find({
          // Only the tills of the user's branches (spec §9)
          where: { tenantId, status: RegisterStatus.ACTIVE, ...branchWhere() },
          relations: { branch: true },
          order: { code: 'ASC' },
        }),
        this.dataSource.getRepository(PaymentMethod).find({
          where: { tenantId, status: PaymentMethodStatus.ACTIVE },
          order: { code: 'ASC' },
        }),
        this.dataSource.getRepository(Category).find({
          where: { tenantId, isActive: true },
          order: { sortOrder: 'ASC', code: 'ASC' },
        }),
      ]);
    return {
      settings,
      taxRate: taxRate ? Number(taxRate.rate) : 0,
      registers,
      paymentMethods,
      categories,
    };
  }
}
