import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { Supplier } from '../database/entities/supplier.entity';
import { SupplierInvoice } from '../database/entities/supplier-invoice.entity';
import { SupplierCredit } from '../database/entities/supplier-credit.entity';
import { SupplierPayment } from '../database/entities/supplier-payment.entity';
import { SupplierAllocation } from '../database/entities/supplier-allocation.entity';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { nextDocumentNumber } from '../common/utils/sequence';
import { fromCents, toCents } from './money';
import {
  AgingResult,
  allocationError,
  AllocatableInvoice,
  buildStatement,
  computeAging,
  isoDate,
  StatementEntry,
} from './payables.logic';
import { allocatedByInvoice } from './supplier-invoices.service';
import {
  AllocateDto,
  AllocationDto,
  CreateSupplierCreditDto,
  CreateSupplierPaymentDto,
  SupplierDocumentsQueryDto,
} from './purchasing.dto';

type Source =
  | { kind: 'payment'; row: SupplierPayment }
  | { kind: 'credit'; row: SupplierCredit };

export interface SupplierAging extends AgingResult {
  supplierId: string;
  supplierCode: string;
  supplierName: string;
  currencyCode: string | null;
}

/**
 * Supplier credits and payments, their allocation to invoices, and what is
 * owed: balances, aging and statements are always derived from the documents
 * (invoices − payments − credits), never stored.
 */
@Injectable()
export class PayablesService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
    private settingsService: SettingsService,
  ) {}

  // ---- Credits ----

  async listCredits(tenantId: string, query: SupplierDocumentsQueryDto) {
    const credits = await this.dataSource.getRepository(SupplierCredit).find({
      where: {
        tenantId,
        ...(query.supplierId && { supplierId: query.supplierId }),
        ...(query.status && {
          status: query.status as SupplierCredit['status'],
        }),
      },
      relations: { supplier: true },
      order: { creditDate: 'DESC', createdAt: 'DESC' },
      take: 300,
    });
    const used = await this.allocatedBySource(
      this.dataSource.manager,
      tenantId,
      'creditId',
      credits.map((c) => c.id),
    );
    return credits.map((c) => this.withAvailable(c, used));
  }

  /** A credit note entered by hand (a return creates its own credit) */
  async createCredit(
    tenantId: string,
    userId: string,
    dto: CreateSupplierCreditDto,
  ) {
    const supplier = await this.findSupplier(tenantId, dto.supplierId);
    const { currencyCode } = await this.settingsService.getSettings(tenantId);
    const credit = await this.dataSource.transaction(async (manager) => {
      const creditNumber = await nextDocumentNumber(manager, {
        table: 'supplier_credits',
        column: 'creditNumber',
        tenantId,
        prefix: 'SC',
      });
      const saved = await manager.save(
        manager.create(SupplierCredit, {
          tenantId,
          creditNumber,
          supplierId: supplier.id,
          creditType: 'manual',
          returnId: null,
          creditDate: (dto.creditDate ?? isoDate(new Date())).slice(0, 10),
          amount: fromCents(toCents(dto.amount)),
          currencyCode: supplier.currencyCode ?? currencyCode,
          reference: dto.reference ?? null,
          reason: dto.reason,
          status: 'open',
          userId,
        }),
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'supplier_credit.created',
          entityType: 'supplier_credit',
          entityId: saved.id,
          reason: dto.reason,
          metadata: {
            creditNumber,
            supplierId: supplier.id,
            amount: saved.amount,
            creditType: 'manual',
            reference: dto.reference ?? null,
          },
        },
        manager,
      );
      return saved;
    });
    return this.getCredit(tenantId, credit.id);
  }

  async getCredit(tenantId: string, id: string) {
    const credit = await this.dataSource.getRepository(SupplierCredit).findOne({
      where: { tenantId, id },
      relations: { supplier: true },
    });
    if (!credit) throw new NotFoundException('Supplier credit not found');
    const used = await this.allocatedBySource(
      this.dataSource.manager,
      tenantId,
      'creditId',
      [id],
    );
    return {
      ...this.withAvailable(credit, used),
      allocations: await this.allocationsOf(tenantId, { creditId: id }),
    };
  }

  async allocateCredit(
    tenantId: string,
    userId: string,
    id: string,
    dto: AllocateDto,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const credit = await manager.findOne(SupplierCredit, {
        where: { tenantId, id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!credit) throw new NotFoundException('Supplier credit not found');
      if (credit.status !== 'open') {
        throw new BadRequestException('This credit is void');
      }
      await this.allocate(
        manager,
        tenantId,
        userId,
        {
          kind: 'credit',
          row: credit,
        },
        dto.allocations,
      );
    });
    return this.getCredit(tenantId, id);
  }

  /** Void a manual credit (nothing may be allocated from it) */
  async voidCredit(tenantId: string, id: string, reason: string) {
    await this.dataSource.transaction(async (manager) => {
      const credit = await manager.findOne(SupplierCredit, {
        where: { tenantId, id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!credit) throw new NotFoundException('Supplier credit not found');
      if (credit.status === 'void') {
        throw new BadRequestException('This credit is already void');
      }
      if (credit.creditType !== 'manual') {
        throw new BadRequestException(
          'A credit from a supplier return cannot be voided',
        );
      }
      const used = await manager.count(SupplierAllocation, {
        where: { tenantId, creditId: id },
      });
      if (used > 0) {
        throw new BadRequestException(
          'This credit is allocated to invoices and cannot be voided',
        );
      }
      credit.status = 'void';
      await manager.save(credit);
      await this.auditService.record(
        {
          tenantId,
          action: 'supplier_credit.voided',
          entityType: 'supplier_credit',
          entityId: id,
          reason,
          metadata: {
            creditNumber: credit.creditNumber,
            supplierId: credit.supplierId,
            amount: credit.amount,
          },
        },
        manager,
      );
    });
    return this.getCredit(tenantId, id);
  }

  // ---- Payments ----

  async listPayments(tenantId: string, query: SupplierDocumentsQueryDto) {
    const payments = await this.dataSource.getRepository(SupplierPayment).find({
      where: {
        tenantId,
        ...(query.supplierId && { supplierId: query.supplierId }),
        ...(query.status && {
          status: query.status as SupplierPayment['status'],
        }),
      },
      relations: { supplier: true },
      order: { paymentDate: 'DESC', createdAt: 'DESC' },
      take: 300,
    });
    const used = await this.allocatedBySource(
      this.dataSource.manager,
      tenantId,
      'paymentId',
      payments.map((p) => p.id),
    );
    return payments.map((p) => this.withAvailable(p, used));
  }

  async getPayment(tenantId: string, id: string) {
    const payment = await this.dataSource
      .getRepository(SupplierPayment)
      .findOne({ where: { tenantId, id }, relations: { supplier: true } });
    if (!payment) throw new NotFoundException('Supplier payment not found');
    const used = await this.allocatedBySource(
      this.dataSource.manager,
      tenantId,
      'paymentId',
      [id],
    );
    return {
      ...this.withAvailable(payment, used),
      allocations: await this.allocationsOf(tenantId, { paymentId: id }),
    };
  }

  /**
   * Record a payment and (optionally) allocate it to invoices, partly or fully.
   * What is not allocated stays on account (unapplied).
   */
  async createPayment(
    tenantId: string,
    userId: string,
    dto: CreateSupplierPaymentDto,
  ) {
    const supplier = await this.findSupplier(tenantId, dto.supplierId);
    const { currencyCode } = await this.settingsService.getSettings(tenantId);
    const id = await this.dataSource.transaction(async (manager) => {
      const paymentNumber = await nextDocumentNumber(manager, {
        table: 'supplier_payments',
        column: 'paymentNumber',
        tenantId,
        prefix: 'SP',
      });
      const payment = await manager.save(
        manager.create(SupplierPayment, {
          tenantId,
          paymentNumber,
          supplierId: supplier.id,
          paymentDate: (dto.paymentDate ?? isoDate(new Date())).slice(0, 10),
          amount: fromCents(toCents(dto.amount)),
          currencyCode: supplier.currencyCode ?? currencyCode,
          method: dto.method,
          reference: dto.reference ?? null,
          notes: dto.notes ?? null,
          status: 'posted',
          userId,
        }),
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'supplier_payment.created',
          entityType: 'supplier_payment',
          entityId: payment.id,
          metadata: {
            paymentNumber,
            supplierId: supplier.id,
            amount: payment.amount,
            method: dto.method,
            reference: dto.reference ?? null,
          },
        },
        manager,
      );
      if (dto.allocations?.length) {
        await this.allocate(
          manager,
          tenantId,
          userId,
          { kind: 'payment', row: payment },
          dto.allocations,
        );
      }
      return payment.id;
    });
    return this.getPayment(tenantId, id);
  }

  async allocatePayment(
    tenantId: string,
    userId: string,
    id: string,
    dto: AllocateDto,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const payment = await manager.findOne(SupplierPayment, {
        where: { tenantId, id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) throw new NotFoundException('Supplier payment not found');
      if (payment.status !== 'posted') {
        throw new BadRequestException('This payment is void');
      }
      await this.allocate(
        manager,
        tenantId,
        userId,
        { kind: 'payment', row: payment },
        dto.allocations,
      );
    });
    return this.getPayment(tenantId, id);
  }

  /** Void a payment recorded by mistake: its allocations are removed */
  async voidPayment(tenantId: string, id: string, reason: string) {
    await this.dataSource.transaction(async (manager) => {
      const payment = await manager.findOne(SupplierPayment, {
        where: { tenantId, id },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) throw new NotFoundException('Supplier payment not found');
      if (payment.status === 'void') {
        throw new BadRequestException('This payment is already void');
      }
      const allocations = await manager.find(SupplierAllocation, {
        where: { tenantId, paymentId: id },
      });
      if (allocations.length) {
        await manager.delete(SupplierAllocation, {
          tenantId,
          id: In(allocations.map((a) => a.id)),
        });
      }
      payment.status = 'void';
      payment.voidedAt = new Date();
      payment.voidReason = reason;
      await manager.save(payment);
      await this.auditService.record(
        {
          tenantId,
          action: 'supplier_payment.voided',
          entityType: 'supplier_payment',
          entityId: id,
          reason,
          metadata: {
            paymentNumber: payment.paymentNumber,
            supplierId: payment.supplierId,
            amount: payment.amount,
            removedAllocations: allocations.map((a) => ({
              invoiceId: a.invoiceId,
              amount: a.amount,
            })),
          },
        },
        manager,
      );
    });
    return this.getPayment(tenantId, id);
  }

  // ---- Balances ----

  /**
   * Aging per supplier as of a date: open invoice amounts by days past due
   * (current, 1–30, 31–60, 61–90, 90+), unapplied payments / credits, balance.
   * Suppliers with nothing owed and nothing unapplied are left out.
   */
  async aging(tenantId: string, asOf?: string, supplierId?: string) {
    const date = (asOf ?? isoDate(new Date())).slice(0, 10);
    const em = this.dataSource.manager;
    const supplierFilter = supplierId ? { supplierId } : {};
    const [invoices, payments, credits, suppliers] = await Promise.all([
      em.find(SupplierInvoice, {
        where: { tenantId, status: Not('void'), ...supplierFilter },
        select: {
          id: true,
          supplierId: true,
          dueDate: true,
          total: true,
          invoiceDate: true,
        },
      }),
      em.find(SupplierPayment, {
        where: { tenantId, status: 'posted', ...supplierFilter },
        select: { id: true, supplierId: true, amount: true, paymentDate: true },
      }),
      em.find(SupplierCredit, {
        where: { tenantId, status: 'open', ...supplierFilter },
        select: { id: true, supplierId: true, amount: true, creditDate: true },
      }),
      em.find(Supplier, {
        where: { tenantId, ...(supplierId && { id: supplierId }) },
        select: { id: true, code: true, name: true, currencyCode: true },
      }),
    ]);
    // Only documents dated on or before the aging date
    const inv = invoices.filter((i) => i.invoiceDate <= date);
    const pay = payments.filter((p) => p.paymentDate <= date);
    const cre = credits.filter((c) => c.creditDate <= date);
    const allocations = await em.find(SupplierAllocation, {
      where: { tenantId, ...supplierFilter },
      select: {
        id: true,
        invoiceId: true,
        paymentId: true,
        creditId: true,
        amount: true,
      },
    });
    const liveSources = new Set([...pay, ...cre].map((s) => s.id));
    const liveInvoices = new Set(inv.map((i) => i.id));
    const allocatedTo = new Map<string, number>();
    const allocatedFrom = new Map<string, number>();
    for (const a of allocations) {
      const source = a.paymentId ?? a.creditId!;
      if (!liveSources.has(source) || !liveInvoices.has(a.invoiceId)) continue;
      allocatedTo.set(
        a.invoiceId,
        (allocatedTo.get(a.invoiceId) ?? 0) + toCents(a.amount),
      );
      allocatedFrom.set(
        source,
        (allocatedFrom.get(source) ?? 0) + toCents(a.amount),
      );
    }

    const rows: SupplierAging[] = [];
    for (const supplier of suppliers) {
      const own = inv.filter((i) => i.supplierId === supplier.id);
      const unappliedCents = [...pay, ...cre]
        .filter((s) => s.supplierId === supplier.id)
        .reduce(
          (sum, s) => sum + toCents(s.amount) - (allocatedFrom.get(s.id) ?? 0),
          0,
        );
      const result = computeAging(
        own.map((i) => ({
          dueDate: i.dueDate,
          total: i.total,
          allocated: fromCents(allocatedTo.get(i.id) ?? 0),
        })),
        fromCents(unappliedCents),
        date,
      );
      if (result.balance === 0 && result.unapplied === 0 && !supplierId) {
        continue;
      }
      rows.push({
        ...result,
        supplierId: supplier.id,
        supplierCode: supplier.code,
        supplierName: supplier.name,
        currencyCode: supplier.currencyCode,
      });
    }
    rows.sort((a, b) => b.balance - a.balance);
    return { asOf: date, suppliers: rows };
  }

  /**
   * Statement of account for one supplier between two dates: opening balance,
   * invoices (debit), credits and payments (credit), running and closing balance
   */
  async statement(
    tenantId: string,
    supplierId: string,
    from?: string,
    to?: string,
  ) {
    const supplier = await this.findSupplier(tenantId, supplierId);
    const toDate = (to ?? isoDate(new Date())).slice(0, 10);
    const fromDate = (from ?? `${toDate.slice(0, 4)}-01-01`).slice(0, 10);
    if (fromDate > toDate) {
      throw new BadRequestException('The start date is after the end date');
    }
    const em = this.dataSource.manager;
    const [invoices, credits, payments] = await Promise.all([
      em.find(SupplierInvoice, {
        where: { tenantId, supplierId, status: Not('void') },
      }),
      em.find(SupplierCredit, {
        where: { tenantId, supplierId, status: 'open' },
      }),
      em.find(SupplierPayment, {
        where: { tenantId, supplierId, status: 'posted' },
      }),
    ]);
    const entries: StatementEntry[] = [
      ...invoices.map((i) => ({
        date: i.invoiceDate,
        type: 'invoice' as const,
        id: i.id,
        number: i.invoiceNumber,
        description:
          i.invoiceType === 'opening_balance'
            ? 'Opening balance'
            : `Invoice due ${i.dueDate}`,
        amount: i.total,
      })),
      ...credits.map((c) => ({
        date: c.creditDate,
        type: 'credit' as const,
        id: c.id,
        number: c.creditNumber,
        description: c.reason,
        amount: c.amount,
      })),
      ...payments.map((p) => ({
        date: p.paymentDate,
        type: 'payment' as const,
        id: p.id,
        number: p.paymentNumber,
        description: [p.method, p.reference].filter(Boolean).join(' · '),
        amount: p.amount,
      })),
    ];
    const statement = buildStatement(entries, fromDate, toDate);
    const aging = await this.aging(tenantId, toDate, supplierId);
    return {
      supplier: {
        id: supplier.id,
        code: supplier.code,
        name: supplier.name,
        currencyCode: supplier.currencyCode,
        paymentTermDays: supplier.paymentTermDays,
      },
      from: fromDate,
      to: toDate,
      ...statement,
      aging: aging.suppliers[0] ?? null,
    };
  }

  /** Invoices of a supplier that can still be paid (open, amount owed) */
  async openInvoices(tenantId: string, supplierId: string) {
    const invoices = await this.dataSource.getRepository(SupplierInvoice).find({
      where: { tenantId, supplierId, status: 'open' },
      order: { dueDate: 'ASC' },
    });
    const allocated = await allocatedByInvoice(
      this.dataSource.manager,
      tenantId,
      invoices.map((i) => i.id),
    );
    return invoices
      .map((i) => ({
        id: i.id,
        invoiceNumber: i.invoiceNumber,
        invoiceDate: i.invoiceDate,
        dueDate: i.dueDate,
        total: i.total,
        amountOpen: fromCents(
          toCents(i.total) - toCents(allocated.get(i.id) ?? 0),
        ),
      }))
      .filter((i) => i.amountOpen > 0);
  }

  // ---- Internals ----

  /**
   * Allocate part of a payment / credit (locked by the caller) to invoices.
   * Invoices are locked too, so concurrent allocations never over-allocate.
   */
  private async allocate(
    manager: EntityManager,
    tenantId: string,
    userId: string,
    source: Source,
    requests: AllocationDto[],
  ) {
    const column = source.kind === 'payment' ? 'paymentId' : 'creditId';
    const invoiceIds = [...new Set(requests.map((r) => r.invoiceId))].sort();
    const invoices = await manager.find(SupplierInvoice, {
      where: { tenantId, id: In(invoiceIds) },
      order: { id: 'ASC' },
      lock: { mode: 'pessimistic_write' },
    });
    const allocatedToInvoices = await allocatedByInvoice(
      manager,
      tenantId,
      invoiceIds,
    );
    const usedFromSource = await this.allocatedBySource(
      manager,
      tenantId,
      column,
      [source.row.id],
    );
    const available = fromCents(
      toCents(source.row.amount) -
        toCents(usedFromSource.get(source.row.id) ?? 0),
    );
    const allocatable = new Map<string, AllocatableInvoice>(
      invoices.map((i) => [
        i.id,
        {
          id: i.id,
          supplierId: i.supplierId,
          status: i.status,
          openAmount: fromCents(
            toCents(i.total) - toCents(allocatedToInvoices.get(i.id) ?? 0),
          ),
        },
      ]),
    );
    const error = allocationError({
      supplierId: source.row.supplierId,
      available,
      invoices: allocatable,
      requests,
    });
    if (error) throw new BadRequestException(error);

    for (const request of requests) {
      await manager.insert(SupplierAllocation, {
        tenantId,
        supplierId: source.row.supplierId,
        invoiceId: request.invoiceId,
        paymentId: source.kind === 'payment' ? source.row.id : null,
        creditId: source.kind === 'credit' ? source.row.id : null,
        amount: fromCents(toCents(request.amount)),
        userId,
      });
    }
    const number =
      source.kind === 'payment'
        ? source.row.paymentNumber
        : source.row.creditNumber;
    await this.auditService.record(
      {
        tenantId,
        action: `supplier_${source.kind}.allocated`,
        entityType: `supplier_${source.kind}`,
        entityId: source.row.id,
        metadata: {
          number,
          supplierId: source.row.supplierId,
          allocations: requests.map((r) => ({
            invoiceId: r.invoiceId,
            invoiceNumber: invoices.find((i) => i.id === r.invoiceId)
              ?.invoiceNumber,
            amount: r.amount,
          })),
        },
      },
      manager,
    );
  }

  private async allocatedBySource(
    manager: EntityManager,
    tenantId: string,
    column: 'paymentId' | 'creditId',
    ids: string[],
  ): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await manager
      .getRepository(SupplierAllocation)
      .createQueryBuilder('a')
      .select(`a.${column}`, 'id')
      .addSelect('COALESCE(SUM(a.amount), 0)', 'amount')
      .where(`a.tenantId = :tenantId AND a.${column} IN (:...ids)`, {
        tenantId,
        ids,
      })
      .groupBy(`a.${column}`)
      .getRawMany<{ id: string; amount: string | number }>();
    return new Map(rows.map((r) => [r.id, Number(r.amount)]));
  }

  private async allocationsOf(
    tenantId: string,
    where: { paymentId: string } | { creditId: string },
  ) {
    const rows = await this.dataSource.getRepository(SupplierAllocation).find({
      where: { tenantId, ...where },
      relations: { invoice: true },
      order: { createdAt: 'ASC' },
    });
    return rows.map((a) => ({
      id: a.id,
      invoiceId: a.invoiceId,
      invoiceNumber: a.invoice?.invoiceNumber ?? null,
      amount: a.amount,
      createdAt: a.createdAt,
    }));
  }

  private withAvailable<
    T extends { id: string; amount: number; status: string },
  >(row: T, used: Map<string, number>) {
    const allocated = fromCents(toCents(used.get(row.id) ?? 0));
    return {
      ...row,
      amountAllocated: allocated,
      amountUnallocated:
        row.status === 'void'
          ? 0
          : fromCents(toCents(row.amount) - toCents(allocated)),
    };
  }

  private async findSupplier(tenantId: string, id: string) {
    const supplier = await this.dataSource
      .getRepository(Supplier)
      .findOne({ where: { tenantId, id } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }
}
