import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { StockLevel } from '../database/entities/stock-level.entity';

// How often overdue reservations are released
export const RESERVATION_SWEEP_INTERVAL_MS = 60_000;
// Stock levels handled per sweep (the rest are picked up by the next one)
const SWEEP_BATCH = 200;

/**
 * Overdue reservation `r` that may expire: not one of a sale still waiting for
 * its card payment (payment_pending, or a payment the provider has not settled).
 * The charge may still go through, so its goods stay held until the sale is
 * completed or cancelled. Held carts expire on time as before.
 */
export const EXPIRABLE_RESERVATION = `NOT EXISTS (
    SELECT 1 FROM sales s
     WHERE r."referenceType" = 'sale'
       AND s.id = (CASE WHEN r."referenceType" = 'sale' THEN r."referenceId"::uuid END)
       AND (s.status = 'payment_pending'
            OR EXISTS (SELECT 1 FROM payments p
                        WHERE p."saleId" = s.id
                          AND p.status IN ('initiated', 'pending', 'authorized', 'unknown'))))`;

/**
 * Releases expired stock reservations in the background (R063).
 *
 * A plain setInterval, not a Bull job: the sweep is one idempotent SQL pass, so
 * it needs no Redis, retries or job history, and it keeps working when Redis is
 * down. Running it on several API instances is safe — each stock level is
 * handled in its own transaction under the stock level's row lock (SKIP LOCKED),
 * the same lock sales and reservations take. Expiry is also enforced lazily:
 * reserve() and a short applyMovement() expire overdue reservations first, so
 * the interval only has to keep the reported numbers fresh.
 *
 * Reservations of sales waiting for a card payment are skipped (see
 * EXPIRABLE_RESERVATION); new ones are also created without an expiry, so the
 * lazy path leaves them alone too.
 */
@Injectable()
export class ReservationExpiryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ReservationExpiryService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private dataSource: DataSource) {}

  onApplicationBootstrap() {
    if (process.env.RESERVATION_SWEEP === 'off') return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, RESERVATION_SWEEP_INTERVAL_MS);
    // Never keep the process alive just for this
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Expire every overdue reservation. Returns the number of units released.
   */
  async sweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let released = 0;
    try {
      const levels = await this.dataSource.query<
        { tenantId: string; variantId: string; locationId: string }[]
      >(
        `SELECT DISTINCT r."tenantId", r."variantId", r."locationId"
           FROM stock_reservations r
          WHERE r.status = 'active' AND r."expiresAt" IS NOT NULL AND r."expiresAt" <= NOW()
            AND ${EXPIRABLE_RESERVATION}
          LIMIT ${SWEEP_BATCH}`,
      );
      for (const key of levels) {
        released += await this.dataSource.transaction(async (manager) => {
          const level = await manager
            .getRepository(StockLevel)
            .createQueryBuilder('level')
            .where('level.tenantId = :tenantId', { tenantId: key.tenantId })
            .andWhere('level.variantId = :variantId', {
              variantId: key.variantId,
            })
            .andWhere('level.locationId = :locationId', {
              locationId: key.locationId,
            })
            .setLock('pessimistic_write')
            .setOnLocked('skip_locked')
            .getOne();
          // Busy right now: whoever holds the lock expires it lazily, or the next sweep does
          if (!level) return 0;
          return this.expireAt(manager, level);
        });
      }
      if (released > 0) {
        this.logger.log(`Released ${released} expired reserved unit(s)`);
      }
    } catch (error) {
      this.logger.error(
        `Reservation sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
    return released;
  }

  /**
   * Expire the overdue reservations at one (locked) stock level, except those of
   * sales waiting for their payment, and give their units back to the level.
   */
  private async expireAt(manager: EntityManager, level: StockLevel) {
    const rows = await manager.query<{ quantity: number }[]>(
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
    const expired = returned.reduce((sum, r) => sum + Number(r.quantity), 0);
    if (expired > 0) {
      level.quantityReserved = Math.max(0, level.quantityReserved - expired);
      level.quantityAvailable = level.quantityOnHand - level.quantityReserved;
      await manager.save(level);
    }
    return expired;
  }
}
