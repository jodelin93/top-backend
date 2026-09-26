import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Payment, PaymentStatus } from '../database/entities/payment.entity';
import { SettlementBatch } from '../database/entities/settlement-batch.entity';
import {
  SettlementLine,
  SettlementLineStatus,
} from '../database/entities/settlement-line.entity';
import { AuditService } from '../audit/audit.service';
import { paginate } from '../common/dto/pagination.dto';
import {
  matchSettlement,
  MatchCandidate,
  SettlementInputLine,
} from './settlement-matcher';

// Provider a payment settles through: its provider, or 'manual' for older non-cash
// payments recorded before providers existed. Cash never settles through an acquirer.
const SETTLEMENT_PROVIDER = `COALESCE(p.provider, CASE WHEN pm."methodType" = 'cash' THEN NULL ELSE 'manual' END)`;

export interface UnreconciledPaymentRow {
  id: string;
  amount: number;
  reference: string | null;
  providerReference: string | null;
  provider: string;
  paymentDate: Date;
  saleId: string;
  saleNumber: string;
  methodName: Record<string, string> | null;
}

/**
 * Card settlement reconciliation (R056): import what the acquirer paid out, match it to
 * captured payments, and let a person resolve whatever does not match on either side.
 */
@Injectable()
export class ReconciliationService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {}

  async importBatch(
    tenantId: string,
    userId: string,
    input: {
      provider: string;
      reference?: string;
      source: 'csv' | 'json';
      lines: SettlementInputLine[];
    },
  ) {
    const batchId = await this.dataSource.transaction(async (manager) => {
      // One import at a time per store, so two batches never claim the same payment
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `settlement:${tenantId}`,
      ]);
      if (input.reference) {
        const duplicate = await manager.findOne(SettlementBatch, {
          where: {
            tenantId,
            provider: input.provider,
            reference: input.reference,
          },
        });
        if (duplicate) {
          throw new ConflictException(
            `Settlement batch ${input.reference} was already imported`,
          );
        }
      }

      const candidates = (
        await this.unreconciledPayments(manager, tenantId, input.provider)
      ).map<MatchCandidate>((p) => ({
        id: p.id,
        references: [p.providerReference, p.reference].filter(
          (r): r is string => !!r,
        ),
        amount: Number(p.amount),
        paidAt: new Date(p.paymentDate),
      }));
      const matches = matchSettlement(input.lines, candidates);
      const matchedCount = matches.filter((m) => m.paymentId).length;
      const cents = (values: number[]) =>
        Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;

      const batch = await manager.save(
        manager.create(SettlementBatch, {
          tenantId,
          provider: input.provider,
          reference: input.reference ?? null,
          source: input.source,
          importedById: userId,
          lineCount: input.lines.length,
          matchedCount,
          totalAmount: cents(input.lines.map((l) => l.amount)),
          totalFees: cents(input.lines.map((l) => l.fee)),
        }),
      );
      await manager.save(
        input.lines.map((line, index) =>
          manager.create(SettlementLine, {
            tenantId,
            batchId: batch.id,
            reference: line.reference,
            amount: line.amount,
            fee: line.fee,
            settledDate: line.date,
            status: matches[index].paymentId
              ? SettlementLineStatus.MATCHED
              : SettlementLineStatus.UNMATCHED,
            paymentId: matches[index].paymentId,
            resolutionNote: matches[index].note,
          }),
        ),
        { chunk: 500 },
      );
      const matchedIds = matches
        .map((m) => m.paymentId)
        .filter((id): id is string => !!id);
      if (matchedIds.length > 0) {
        await manager
          .createQueryBuilder()
          .update(Payment)
          .set({
            reconciledAt: () => 'NOW()',
            reconciliationNote: `Settlement ${input.reference ?? batch.id.slice(0, 8)}`,
          })
          .where('"tenantId" = :tenantId AND id IN (:...ids)', {
            tenantId,
            ids: matchedIds,
          })
          .execute();
      }

      await this.auditService.record(
        {
          tenantId,
          action: 'settlement.imported',
          entityType: 'settlement_batch',
          entityId: batch.id,
          metadata: {
            provider: input.provider,
            reference: input.reference ?? null,
            lines: input.lines.length,
            matched: matchedCount,
            totalAmount: batch.totalAmount,
          },
        },
        manager,
      );
      return batch.id;
    });
    return this.getBatch(tenantId, batchId);
  }

  async listBatches(tenantId: string, page = 1, limit = 25) {
    const [data, total] = await this.dataSource
      .getRepository(SettlementBatch)
      .findAndCount({
        where: { tenantId },
        order: { createdAt: 'DESC' },
        skip: (page - 1) * limit,
        take: limit,
      });
    return paginate(data, total, page, limit);
  }

  async getBatch(tenantId: string, id: string) {
    const batch = await this.dataSource
      .getRepository(SettlementBatch)
      .findOne({ where: { id, tenantId } });
    if (!batch) throw new NotFoundException('Settlement batch not found');
    const lines = await this.linesQuery(tenantId)
      .andWhere('line.batchId = :id', { id })
      .orderBy('line.created_at', 'ASC')
      .getRawMany<Record<string, unknown>>();
    return { ...batch, lines };
  }

  /**
   * Both sides of what is not reconciled yet: settlement lines with no payment,
   * and captured card payments that no settlement has covered
   */
  async unmatched(tenantId: string, provider?: string) {
    const lines = await this.linesQuery(tenantId)
      .andWhere('line.status = :status', {
        status: SettlementLineStatus.UNMATCHED,
      })
      .andWhere(provider ? 'batch.provider = :provider' : '1=1', { provider })
      .orderBy('line.created_at', 'DESC')
      .limit(500)
      .getRawMany<Record<string, unknown>>();
    const payments = await this.unreconciledPayments(
      this.dataSource.manager,
      tenantId,
      provider,
    );
    return { lines, payments };
  }

  /** Close a settlement line by hand, optionally linking the payment it belongs to */
  async resolveLine(
    tenantId: string,
    userId: string,
    lineId: string,
    input: { note: string; paymentId?: string },
  ) {
    await this.dataSource.transaction(async (manager) => {
      const line = await manager.findOne(SettlementLine, {
        where: { id: lineId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!line) throw new NotFoundException('Settlement line not found');
      if (line.status !== SettlementLineStatus.UNMATCHED) {
        throw new ConflictException('This line is already reconciled');
      }
      if (input.paymentId) {
        const payment = await manager.findOne(Payment, {
          where: { id: input.paymentId, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!payment) throw new NotFoundException('Payment not found');
        if (payment.reconciledAt) {
          throw new ConflictException('That payment is already reconciled');
        }
        if (
          payment.status !== PaymentStatus.CAPTURED &&
          payment.status !== PaymentStatus.COMPLETED
        ) {
          throw new BadRequestException(
            'Only captured payments can be matched',
          );
        }
        await manager.update(
          Payment,
          { id: payment.id },
          { reconciledAt: new Date(), reconciliationNote: input.note },
        );
        await manager.update(
          SettlementBatch,
          { id: line.batchId },
          { matchedCount: () => '"matchedCount" + 1' },
        );
      }
      await manager.update(
        SettlementLine,
        { id: line.id },
        {
          status: input.paymentId
            ? SettlementLineStatus.MATCHED
            : SettlementLineStatus.RESOLVED,
          paymentId: input.paymentId ?? null,
          resolvedById: userId,
          resolvedAt: new Date(),
          resolutionNote: input.note,
        },
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'settlement.line_resolved',
          entityType: 'settlement_line',
          entityId: line.id,
          reason: input.note,
          metadata: {
            batchId: line.batchId,
            reference: line.reference,
            amount: line.amount,
            paymentId: input.paymentId ?? null,
          },
        },
        manager,
      );
    });
    return { ok: true };
  }

  /** Mark a captured payment as reconciled without a settlement line */
  async resolvePayment(tenantId: string, paymentId: string, note: string) {
    await this.dataSource.transaction(async (manager) => {
      const payment = await manager.findOne(Payment, {
        where: { id: paymentId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) throw new NotFoundException('Payment not found');
      if (payment.reconciledAt) {
        throw new ConflictException('This payment is already reconciled');
      }
      await manager.update(
        Payment,
        { id: payment.id },
        { reconciledAt: new Date(), reconciliationNote: note },
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'payment.reconciled_manually',
          entityType: 'payment',
          entityId: payment.id,
          reason: note,
          metadata: { saleId: payment.saleId, amount: payment.amount },
        },
        manager,
      );
    });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------

  private linesQuery(tenantId: string) {
    return this.dataSource
      .getRepository(SettlementLine)
      .createQueryBuilder('line')
      .innerJoin('line.batch', 'batch')
      .leftJoin(Payment, 'p', 'p.id = line.paymentId')
      .leftJoin('sales', 's', 's.id = p."saleId"')
      .select([
        'line.id AS id',
        'line.batchId AS "batchId"',
        'batch.provider AS provider',
        'batch.reference AS "batchReference"',
        'line.reference AS reference',
        'line.amount AS amount',
        'line.fee AS fee',
        'line.settledDate AS "settledDate"',
        'line.status AS status',
        'line.paymentId AS "paymentId"',
        'line.resolutionNote AS "resolutionNote"',
        'line.resolvedAt AS "resolvedAt"',
        's.id AS "saleId"',
        's."saleNumber" AS "saleNumber"',
      ])
      .where('line.tenantId = :tenantId', { tenantId });
  }

  private unreconciledPayments(
    manager: EntityManager,
    tenantId: string,
    provider?: string,
  ): Promise<UnreconciledPaymentRow[]> {
    return manager.query<UnreconciledPaymentRow[]>(
      `SELECT p.id, p.amount, p.reference, p."providerReference",
              ${SETTLEMENT_PROVIDER} AS provider, p."paymentDate",
              s.id AS "saleId", s."saleNumber", pm.name AS "methodName"
       FROM payments p
       JOIN payment_methods pm ON pm.id = p."paymentMethodId"
       JOIN sales s ON s.id = p."saleId"
       WHERE p."tenantId" = $1
         AND p.status IN ('captured', 'completed')
         AND p."reconciledAt" IS NULL
         AND ${SETTLEMENT_PROVIDER} IS NOT NULL
         AND ($2::text IS NULL OR ${SETTLEMENT_PROVIDER} = $2)
       ORDER BY p."paymentDate" DESC
       LIMIT 5000`,
      [tenantId, provider ?? null],
    );
  }
}
