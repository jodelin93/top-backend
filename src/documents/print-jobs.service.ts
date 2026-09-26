import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { requestContext } from '../common/context/request-context';
import { canAccessBranch, hasAllBranches } from '../auth/branch-scope';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { returnedRows } from '../platform/outbox/event-handler.registry';
import {
  PrintJob,
  type DocumentType,
  type PrintJobStatus,
} from './print-job.entity';
import {
  canMoveTo,
  DOCUMENT_SOURCES,
  LIVE_STATUSES,
  printPermissions,
  retryAs,
  UNPRINTABLE_SALE_STATUSES,
} from './print-job-rules';
import type { CreatePrintJobDto, UpdatePrintJobDto } from './documents.dto';

/** Who is printing: the signed-in user and their effective permissions */
export interface PrintActor {
  id: string;
  permissions: readonly string[];
}

const ORIGINAL_INDEX = 'UQ_print_jobs_original';

/**
 * Print history (spec §15). The POS records a job before it prints anything
 * (original, reprint, credit note, pro forma, Z-report, labels), prints what the
 * answer says (original or COPY #n), then reports the outcome.
 */

// Branch of each printable document (row alias d)
const DOCUMENT_BRANCH_SQL: Record<Exclude<DocumentType, 'label'>, string> = {
  receipt: 'd."branchId"',
  invoice: 'd."branchId"',
  credit_note: `(SELECT s."branchId" FROM sales s WHERE s.id = d."originalSaleId")`,
  pro_forma: 'd."branchId"',
  z_report: `COALESCE(d."branchId", (SELECT r."branchId" FROM registers r WHERE r.id = d."registerId"))`,
};

@Injectable()
export class PrintJobsService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {}

  async create(
    tenantId: string,
    actor: PrintActor,
    dto: CreatePrintJobDto,
    retryOfId: string | null = null,
  ): Promise<PrintJob> {
    try {
      return await this.insert(tenantId, actor, dto, retryOfId);
    } catch (error) {
      // Another till took the original at the same moment: this print is a copy
      if (!dto.copy && isPgError(error, PG_UNIQUE_VIOLATION, ORIGINAL_INDEX)) {
        return this.insert(tenantId, actor, { ...dto, copy: true }, retryOfId);
      }
      throw error;
    }
  }

  private insert(
    tenantId: string,
    actor: PrintActor,
    dto: CreatePrintJobDto,
    retryOfId: string | null,
  ): Promise<PrintJob> {
    return this.dataSource.transaction(async (manager) => {
      const documentNumber = await this.loadDocument(
        manager,
        tenantId,
        dto.documentType,
        dto.documentId,
      );
      const repo = manager.getRepository(PrintJob);
      let copy = !!dto.copy;
      if (!copy) {
        const live = await repo.findOne({
          where: {
            tenantId,
            documentType: dto.documentType,
            documentId: dto.documentId,
            copy: false,
            status: In(LIVE_STATUSES),
          },
        });
        // The original is out (or may be): anything printed now is a copy
        if (live) copy = true;
      }
      this.assertAllowed(actor, dto.documentType, copy);

      const copyNumber = copy
        ? await this.nextCopyNumber(
            manager,
            tenantId,
            dto.documentType,
            dto.documentId,
          )
        : null;
      const job = await repo.save(
        repo.create({
          tenantId,
          documentType: dto.documentType,
          documentId: dto.documentId,
          documentNumber,
          copy,
          copyNumber,
          deviceId: requestContext.get()?.deviceId ?? null,
          printerId: dto.printerId ?? null,
          channel: dto.channel ?? 'browser',
          status: 'queued',
          error: null,
          retryOfId,
          userId: actor.id,
        }),
      );
      if (copy) {
        await this.auditService.record(
          {
            tenantId,
            // Same action as before print jobs existed, for sale receipts
            action: ['receipt', 'invoice'].includes(dto.documentType)
              ? 'sale.receipt_reprinted'
              : 'document.reprinted',
            entityType: this.entityType(dto.documentType),
            entityId: dto.documentId,
            metadata: {
              documentType: dto.documentType,
              documentNumber,
              copyNumber,
              printJobId: job.id,
              retryOfId,
            },
          },
          manager,
        );
      }
      return job;
    });
  }

  /** The POS reports how the print went */
  async updateStatus(
    tenantId: string,
    id: string,
    dto: UpdatePrintJobDto,
  ): Promise<PrintJob> {
    const repo = this.dataSource.getRepository(PrintJob);
    const job = await repo.findOne({ where: { id, tenantId } });
    if (
      !job ||
      !(await this.documentVisible(
        this.dataSource.manager,
        tenantId,
        job.documentType,
        job.documentId,
      ))
    ) {
      throw new NotFoundException('Print job not found');
    }
    if (!canMoveTo(job.status, dto.status)) {
      throw new ConflictException({
        message: `Cannot mark a print job that is ${job.status} as ${dto.status}`,
        code: 'INVALID_STATE_TRANSITION',
      });
    }
    if (job.status === dto.status && !dto.error) return job;
    // Guarded on the status read, so two reports cannot both move it
    const result = await repo.update(
      { id, tenantId, status: job.status },
      {
        status: dto.status,
        error: dto.error?.slice(0, 1000) ?? job.error,
        updatedAt: new Date(),
      },
    );
    if (!result.affected) {
      throw new ConflictException('The print job changed meanwhile, reload it');
    }
    return { ...job, status: dto.status, error: dto.error ?? job.error };
  }

  /**
   * Print again after a failed or uncertain print. An uncertain print is retried
   * as a COPY (never a second original, never a new sale). Only the document is
   * re-printed: a retry never opens the cash drawer.
   */
  async retry(
    tenantId: string,
    actor: PrintActor,
    id: string,
  ): Promise<PrintJob> {
    const repo = this.dataSource.getRepository(PrintJob);
    const previous = await repo.findOne({ where: { id, tenantId } });
    if (
      !previous ||
      !(await this.documentVisible(
        this.dataSource.manager,
        tenantId,
        previous.documentType,
        previous.documentId,
      ))
    ) {
      throw new NotFoundException('Print job not found');
    }
    const plan = retryAs(previous);
    if (!plan) {
      throw new BadRequestException(
        'This document was printed; print a copy instead of retrying',
      );
    }
    // A job still in flight is settled as unknown before its retry
    if (previous.status === 'queued' || previous.status === 'sent') {
      await repo.update(
        { id, tenantId, status: previous.status },
        { status: 'unknown', updatedAt: new Date() },
      );
    }
    return this.create(
      tenantId,
      actor,
      {
        documentType: previous.documentType,
        documentId: previous.documentId,
        copy: plan.copy,
        channel: previous.channel,
        printerId: previous.printerId ?? undefined,
      },
      previous.id,
    );
  }

  /** Print history of one document, newest first, with who printed it */
  async list(tenantId: string, documentType: DocumentType, documentId: string) {
    await this.assertDocumentBranch(
      this.dataSource.manager,
      tenantId,
      documentType,
      documentId,
    );
    const types =
      documentType === 'receipt' || documentType === 'invoice'
        ? ['receipt', 'invoice']
        : [documentType];
    return this.dataSource.query<Record<string, unknown>[]>(
      `SELECT j.id, j."documentType", j."documentId", j."documentNumber", j.copy,
              j."copyNumber", j."deviceId", j."printerId", j.channel, j.status, j.error,
              j."retryOfId", j."userId", j."createdAt", j."updatedAt",
              NULLIF(TRIM(CONCAT(u."firstName", ' ', u."lastName")), '') AS "userName"
         FROM print_jobs j
         LEFT JOIN users u ON u.id = j."userId"
        WHERE j."tenantId" = $1 AND j."documentType" = ANY($2::text[]) AND j."documentId" = $3
        ORDER BY j."createdAt" DESC
        LIMIT 200`,
      [tenantId, types, documentId],
    );
  }

  // ---------------------------------------------------------------------------

  private assertAllowed(
    actor: PrintActor,
    documentType: DocumentType,
    copy: boolean,
  ) {
    const needed = printPermissions(documentType, copy);
    if (!needed.some((p) => actor.permissions.includes(p))) {
      throw new ForbiddenException(
        copy
          ? 'This document was already printed. Printing a copy needs the reprint permission.'
          : 'You are not allowed to print this document',
      );
    }
  }

  private entityType(documentType: DocumentType) {
    return documentType === 'label'
      ? 'label'
      : DOCUMENT_SOURCES[documentType].table.replace(/s$/, '');
  }

  /**
   * Branch access (spec §9): a document of another branch is "not found" for a
   * branch-limited user. Pro formas without a branch are store-level.
   */
  private async documentVisible(
    manager: EntityManager,
    tenantId: string,
    documentType: DocumentType,
    documentId: string,
  ): Promise<boolean> {
    if (documentType === 'label' || hasAllBranches()) return true;
    const branchOf = DOCUMENT_BRANCH_SQL[documentType];
    const source = DOCUMENT_SOURCES[documentType];
    const [row] = await manager.query<{ branchId: string | null }[]>(
      `SELECT ${branchOf} AS "branchId" FROM "${source.table}" d
        WHERE d.id = $1 AND d."tenantId" = $2`,
      [documentId, tenantId],
    );
    if (!row) return true; // unknown: the caller reports it missing
    if (!row.branchId) return documentType === 'pro_forma';
    return canAccessBranch(row.branchId);
  }

  private async assertDocumentBranch(
    manager: EntityManager,
    tenantId: string,
    documentType: DocumentType,
    documentId: string,
  ) {
    if (
      !(await this.documentVisible(manager, tenantId, documentType, documentId))
    ) {
      throw new NotFoundException('Document not found');
    }
  }

  /** The document's number; 404 when it is not in this store */
  private async loadDocument(
    manager: EntityManager,
    tenantId: string,
    documentType: DocumentType,
    documentId: string,
  ): Promise<string | null> {
    // Labels are printed for products or batches: no document row to check
    if (documentType === 'label') return null;
    const source = DOCUMENT_SOURCES[documentType];
    const [row] = await manager.query<
      { number: string | null; status?: string }[]
    >(
      `SELECT "${source.number}" AS number${source.table === 'sales' ? ', status' : ''}
         FROM "${source.table}" WHERE id = $1 AND "tenantId" = $2`,
      [documentId, tenantId],
    );
    if (!row) throw new NotFoundException('Document not found');
    await this.assertDocumentBranch(
      manager,
      tenantId,
      documentType,
      documentId,
    );
    if (
      source.table === 'sales' &&
      UNPRINTABLE_SALE_STATUSES.includes(String(row.status))
    ) {
      throw new ConflictException(
        'Only finished sales have a receipt to print',
      );
    }
    return row.number ?? null;
  }

  /**
   * Next copy number. Sale receipts keep counting on sales.receiptPrintCount (the
   * counter the sale history shows); other documents count their copy jobs under
   * a transaction lock.
   */
  private async nextCopyNumber(
    manager: EntityManager,
    tenantId: string,
    documentType: DocumentType,
    documentId: string,
  ): Promise<number> {
    if (documentType === 'receipt' || documentType === 'invoice') {
      const rows = returnedRows<{ receiptPrintCount: number }>(
        await manager.query(
          `UPDATE sales SET "receiptPrintCount" = "receiptPrintCount" + 1
            WHERE id = $1 AND "tenantId" = $2 RETURNING "receiptPrintCount"`,
          [documentId, tenantId],
        ),
      );
      return Number(rows[0]?.receiptPrintCount ?? 1);
    }
    await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `print:${tenantId}:${documentType}:${documentId}`,
    ]);
    const copies = await manager.getRepository(PrintJob).count({
      where: { tenantId, documentType, documentId, copy: true },
    });
    return copies + 1;
  }
}

export type { PrintJobStatus };
