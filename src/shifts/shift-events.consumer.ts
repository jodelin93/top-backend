import { Injectable, OnModuleInit, Optional } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { EventHandlerRegistry } from '../platform/outbox/event-handler.registry';
import type { DeliveredEvent } from '../events/event-types';
import { AuditService } from '../audit/audit.service';
import { ConflictCaseType } from '../database/entities/conflict-case.entity';
import { openConflictCase } from '../sales/conflict-cases.service';
import { round2 } from '../sales/sale-calculator';
import {
  LEDGER_PAYMENT_STATUSES,
  LEDGER_SALE_STATUSES,
  netCashSql,
  syncSaleCashMovements,
} from './sale-ledger';

export const SALE_LEDGER_CONSUMER = 'shifts.sale-cash-ledger';
export const LATE_SHIFT_CONSUMER = 'shifts.late-shift-cases';

interface LateSaleRow {
  id: string;
  saleNumber: string;
  deviceId: string | null;
  recordedAt: Date | string;
  total: string | number;
  currencyCode: string;
  net: string | number;
  shiftId: string;
  shiftNumber: string;
  status: string;
  closedAt: Date | string | null;
}

/**
 * Outbox consumers of the shifts module (sale.completed):
 * - the per-sale drawer ledger ('sale' cash movement, idempotent per sale)
 * - a late_shift review case when the sale belongs to a shift that was already
 *   closed when it was recorded (offline sale uploaded after the close)
 */
@Injectable()
export class ShiftEventsConsumer implements OnModuleInit {
  constructor(
    private auditService: AuditService,
    @Optional() private registry?: EventHandlerRegistry,
  ) {}

  onModuleInit() {
    this.registry?.register(SALE_LEDGER_CONSUMER, 'sale.completed', (e, m) =>
      this.recordSaleCash(e, m),
    );
    this.registry?.register(LATE_SHIFT_CONSUMER, 'sale.completed', (e, m) =>
      this.openLateShiftCase(e, m),
    );
  }

  async recordSaleCash(
    event: DeliveredEvent<'sale.completed'>,
    manager: EntityManager,
  ): Promise<void> {
    const rows = await syncSaleCashMovements(manager, {
      tenantId: event.tenantId,
      saleId: event.payload.saleId,
    });
    for (const row of rows) {
      await this.auditService.record(
        {
          tenantId: event.tenantId,
          action: 'cash_movement.sale',
          entityType: 'shift',
          entityId: row.shiftId,
          actorId: event.actorId ?? undefined,
          metadata: {
            movementId: row.id,
            saleId: row.sourceId,
            saleNumber: event.payload.saleNumber,
            amount: round2(Number(row.amount)),
          },
        },
        manager,
      );
    }
  }

  async openLateShiftCase(
    event: DeliveredEvent<'sale.completed'>,
    manager: EntityManager,
  ): Promise<void> {
    const [sale] = await manager.query<LateSaleRow[]>(
      `SELECT s.id, s."saleNumber", s."deviceId", s.created_at AS "recordedAt", s.total,
              TRIM(s."currencyCode") AS "currencyCode", ${netCashSql('$4')} AS net,
              sh.id AS "shiftId", sh."shiftNumber", sh.status::text AS status, sh."closedAt"
       FROM sales s
       JOIN shifts sh ON sh.id = s."shiftId" AND sh."tenantId" = s."tenantId"
       WHERE s."tenantId" = $1 AND s.id = $2 AND s.status::text = ANY($3)`,
      [
        event.tenantId,
        event.payload.saleId,
        LEDGER_SALE_STATUSES,
        LEDGER_PAYMENT_STATUSES,
      ],
    );
    if (!sale || sale.status !== 'closed' || !sale.closedAt) return;
    if (new Date(sale.recordedAt) <= new Date(sale.closedAt)) return;

    const existing = await manager.query<unknown[]>(
      `SELECT 1 FROM conflict_cases
       WHERE "tenantId" = $1 AND "saleId" = $2 AND type = $3 LIMIT 1`,
      [event.tenantId, sale.id, ConflictCaseType.LATE_SHIFT],
    );
    if (existing.length > 0) return;

    const cash = Math.max(0, round2(Number(sale.net)));
    const created = await openConflictCase(manager, {
      tenantId: event.tenantId,
      type: ConflictCaseType.LATE_SHIFT,
      saleId: sale.id,
      deviceId: sale.deviceId,
      details: {
        saleNumber: sale.saleNumber,
        shiftId: sale.shiftId,
        shiftNumber: sale.shiftNumber,
        shiftClosedAt: new Date(sale.closedAt).toISOString(),
        recordedAt: new Date(sale.recordedAt).toISOString(),
        total: round2(Number(sale.total)),
        cash,
        currencyCode: sale.currencyCode,
      },
    });
    await this.auditService.record(
      {
        tenantId: event.tenantId,
        action: 'conflict_case.opened',
        entityType: 'conflict_case',
        entityId: created.id,
        metadata: {
          type: ConflictCaseType.LATE_SHIFT,
          saleId: sale.id,
          shiftId: sale.shiftId,
          shiftNumber: sale.shiftNumber,
          cash,
        },
      },
      manager,
    );
  }
}
