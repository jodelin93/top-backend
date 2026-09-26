import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { Supplier } from '../database/entities/supplier.entity';
import { PurchaseOrder } from '../database/entities/purchase-order.entity';
import { PurchaseOrderItem } from '../database/entities/purchase-order-item.entity';
import { GoodsReceiptItem } from '../database/entities/goods-receipt-item.entity';
import { GoodsReceipt } from '../database/entities/goods-receipt.entity';
import { SupplierInvoice } from '../database/entities/supplier-invoice.entity';
import { SupplierInvoiceItem } from '../database/entities/supplier-invoice-item.entity';
import { SupplierAllocation } from '../database/entities/supplier-allocation.entity';
import { User } from '../database/entities/user.entity';
import { AuditService } from '../audit/audit.service';
import { SettingsService } from '../settings/settings.service';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { fromCents, lineAmount, toCents } from './money';
import { netUnitCost } from './purchase-order.logic';
import { addDays, isoDate, matchInvoiceLine } from './payables.logic';
import { addQty, subQty } from '../common/utils/quantity';
import {
  CreateSupplierInvoiceDto,
  SupplierDocumentsQueryDto,
} from './purchasing.dto';

/** Amount allocated (payments + credits) per invoice */
export async function allocatedByInvoice(
  manager: EntityManager,
  tenantId: string,
  invoiceIds: string[],
): Promise<Map<string, number>> {
  if (invoiceIds.length === 0) return new Map();
  const rows = await manager
    .getRepository(SupplierAllocation)
    .createQueryBuilder('a')
    .select('a.invoiceId', 'invoiceId')
    .addSelect('COALESCE(SUM(a.amount), 0)', 'amount')
    .where('a.tenantId = :tenantId AND a.invoiceId IN (:...invoiceIds)', {
      tenantId,
      invoiceIds,
    })
    .groupBy('a.invoiceId')
    .getRawMany<{ invoiceId: string; amount: string | number }>();
  return new Map(rows.map((r) => [r.invoiceId, Number(r.amount)]));
}

const DUPLICATE_MESSAGE =
  'This invoice number was already entered for this supplier';

/**
 * Supplier invoices (accounts payable) with 3-way match against the order
 * (ordered price) and receipts (received quantity). A line outside the
 * tolerance puts the invoice on hold until someone with purchasing.approve
 * approves it; only approved (open) invoices can be paid.
 */
@Injectable()
export class SupplierInvoicesService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
    private settingsService: SettingsService,
  ) {}

  async list(tenantId: string, query: SupplierDocumentsQueryDto) {
    const qb = this.dataSource
      .getRepository(SupplierInvoice)
      .createQueryBuilder('inv')
      .leftJoinAndSelect('inv.supplier', 'supplier')
      .leftJoinAndSelect('inv.purchaseOrder', 'po')
      .where('inv.tenantId = :tenantId', { tenantId })
      .orderBy('inv.invoiceDate', 'DESC')
      .addOrderBy('inv.created_at', 'DESC')
      .take(300);
    if (query.supplierId) {
      qb.andWhere('inv.supplierId = :supplierId', {
        supplierId: query.supplierId,
      });
    }
    if (query.status) {
      qb.andWhere('inv.status = :status', { status: query.status });
    }
    if (query.purchaseOrderId) {
      qb.andWhere('inv.purchaseOrderId = :purchaseOrderId', {
        purchaseOrderId: query.purchaseOrderId,
      });
    }
    const invoices = await qb.getMany();
    const allocated = await allocatedByInvoice(
      this.dataSource.manager,
      tenantId,
      invoices.map((i) => i.id),
    );
    return invoices.map((invoice) => this.withAmounts(invoice, allocated));
  }

  async get(tenantId: string, id: string) {
    const invoice = await this.dataSource
      .getRepository(SupplierInvoice)
      .createQueryBuilder('inv')
      .leftJoinAndSelect('inv.supplier', 'supplier')
      .leftJoinAndSelect('inv.purchaseOrder', 'po')
      .leftJoinAndSelect('inv.items', 'item')
      .where('inv.tenantId = :tenantId AND inv.id = :id', { tenantId, id })
      .orderBy('item.lineNumber', 'ASC')
      .getOne();
    if (!invoice) throw new NotFoundException('Supplier invoice not found');
    const allocations = await this.dataSource
      .getRepository(SupplierAllocation)
      .find({
        where: { tenantId, invoiceId: id },
        relations: { payment: true, credit: true },
        order: { createdAt: 'ASC' },
      });
    const allocated = await allocatedByInvoice(
      this.dataSource.manager,
      tenantId,
      [id],
    );
    const userIds = [invoice.userId, invoice.approvedById].filter(
      (u): u is string => !!u,
    );
    const users = await this.dataSource.getRepository(User).find({
      where: { id: In(userIds) },
      select: { id: true, firstName: true, lastName: true, email: true },
    });
    const name = (userId: string | null) => {
      const u = users.find((x) => x.id === userId);
      return u
        ? [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email
        : null;
    };
    return {
      ...this.withAmounts(invoice, allocated),
      allocations: allocations.map((a) => ({
        id: a.id,
        amount: a.amount,
        createdAt: a.createdAt,
        paymentId: a.paymentId,
        paymentNumber: a.payment?.paymentNumber ?? null,
        creditId: a.creditId,
        creditNumber: a.credit?.creditNumber ?? null,
      })),
      createdByName: name(invoice.userId),
      approvedByName: name(invoice.approvedById),
    };
  }

  async create(
    tenantId: string,
    userId: string,
    dto: CreateSupplierInvoiceDto,
  ) {
    const supplier = await this.dataSource
      .getRepository(Supplier)
      .findOne({ where: { tenantId, id: dto.supplierId } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    const settings = await this.settingsService.getSettings(tenantId);
    const tolerance = settings.purchaseInvoiceVarianceTolerance ?? 0;
    const invoiceNumber = dto.invoiceNumber.trim();
    if (!invoiceNumber) {
      throw new BadRequestException('The invoice number is required');
    }
    const type = dto.invoiceType ?? 'standard';
    const invoiceDate = dto.invoiceDate.slice(0, 10);
    const dueDate = (
      dto.dueDate ?? addDays(invoiceDate, supplier.paymentTermDays ?? 0)
    ).slice(0, 10);
    if (dueDate < invoiceDate) {
      throw new BadRequestException(
        'The due date cannot be before the invoice date',
      );
    }

    try {
      const id = await this.dataSource.transaction(async (manager) => {
        await this.assertNotDuplicate(
          manager,
          tenantId,
          supplier.id,
          invoiceNumber,
        );

        if (type === 'opening_balance') {
          if (!dto.amount) {
            throw new BadRequestException(
              'An opening balance needs the amount owed',
            );
          }
          if (dto.items?.length || dto.purchaseOrderId) {
            throw new BadRequestException(
              'An opening balance has an amount only (no lines or order)',
            );
          }
          const amount = fromCents(toCents(dto.amount));
          const invoice = await manager.save(
            manager.create(SupplierInvoice, {
              tenantId,
              supplierId: supplier.id,
              invoiceNumber,
              invoiceType: 'opening_balance',
              purchaseOrderId: null,
              invoiceDate,
              dueDate,
              currencyCode: supplier.currencyCode ?? settings.currencyCode,
              subtotal: amount,
              taxAmount: 0,
              total: amount,
              status: 'open',
              hasVariance: false,
              notes: dto.notes ?? null,
              userId,
            }),
          );
          await this.auditService.record(
            {
              tenantId,
              action: 'supplier_invoice.created',
              entityType: 'supplier_invoice',
              entityId: invoice.id,
              metadata: {
                invoiceNumber,
                supplierId: supplier.id,
                invoiceType: 'opening_balance',
                total: amount,
              },
            },
            manager,
          );
          return invoice.id;
        }

        if (!dto.items?.length) {
          throw new BadRequestException('Add at least one invoice line');
        }
        if (dto.amount !== undefined) {
          throw new BadRequestException(
            'The amount is computed from the lines (only an opening balance takes an amount)',
          );
        }
        let po: PurchaseOrder | null = null;
        if (dto.purchaseOrderId) {
          po = await manager.findOne(PurchaseOrder, {
            where: { tenantId, id: dto.purchaseOrderId },
          });
          if (!po) throw new NotFoundException('Purchase order not found');
          if (po.supplierId !== supplier.id) {
            throw new BadRequestException(
              'The purchase order is from another supplier',
            );
          }
        }

        // Lock the matched order lines: invoiced quantities are checked against them
        const poItemIds = [
          ...new Set(
            dto.items
              .map((i) => i.purchaseOrderItemId)
              .filter((x): x is string => !!x),
          ),
        ];
        const poItems = poItemIds.length
          ? await manager.find(PurchaseOrderItem, {
              where: { tenantId, id: In(poItemIds) },
              order: { id: 'ASC' },
              lock: { mode: 'pessimistic_write' },
            })
          : [];
        if (poItems.length !== poItemIds.length) {
          throw new NotFoundException('One or more order lines were not found');
        }
        const orders = poItems.length
          ? await manager.find(PurchaseOrder, {
              where: {
                tenantId,
                id: In([...new Set(poItems.map((i) => i.purchaseOrderId))]),
              },
            })
          : [];
        const orderSupplier = new Map(orders.map((o) => [o.id, o.supplierId]));
        for (const item of poItems) {
          if (orderSupplier.get(item.purchaseOrderId) !== supplier.id) {
            throw new BadRequestException(
              'An invoice line is matched to another supplier’s order',
            );
          }
          if (po && item.purchaseOrderId !== po.id) {
            throw new BadRequestException(
              'An invoice line is not on the chosen purchase order',
            );
          }
        }
        const invoicedElsewhere = await this.invoicedQuantities(
          manager,
          tenantId,
          poItemIds,
        );

        const receiptItemIds = dto.items
          .map((i) => i.receiptItemId)
          .filter((x): x is string => !!x);
        const receiptItems = receiptItemIds.length
          ? await manager.find(GoodsReceiptItem, {
              where: { tenantId, id: In(receiptItemIds) },
            })
          : [];
        const receipts = receiptItems.length
          ? await manager.find(GoodsReceipt, {
              where: {
                tenantId,
                id: In([...new Set(receiptItems.map((r) => r.receiptId))]),
              },
            })
          : [];
        const receiptSupplier = new Map(
          receipts.map((r) => [r.id, r.supplierId]),
        );
        const receiptItemById = new Map(receiptItems.map((r) => [r.id, r]));

        const poItemById = new Map(poItems.map((i) => [i.id, i]));
        const usedHere = new Map<string, number>();
        const lines = dto.items.map((line, index) => {
          const poItem = line.purchaseOrderItemId
            ? poItemById.get(line.purchaseOrderItemId)
            : undefined;
          if (line.receiptItemId) {
            const receiptItem = receiptItemById.get(line.receiptItemId);
            if (
              !receiptItem ||
              receiptSupplier.get(receiptItem.receiptId) !== supplier.id
            ) {
              throw new BadRequestException(
                'An invoice line is matched to a receipt of another supplier',
              );
            }
            if (poItem && receiptItem.purchaseOrderItemId !== poItem.id) {
              throw new BadRequestException(
                'An invoice line’s receipt line and order line do not match',
              );
            }
          }
          const description = (
            line.description?.trim() ||
            poItem?.productName ||
            ''
          ).slice(0, 255);
          if (!description) {
            throw new BadRequestException(
              'A line not matched to the order needs a description',
            );
          }
          const subtotal = lineAmount(line.quantity, line.unitPrice);
          const taxAmount = fromCents(toCents(line.taxAmount ?? 0));
          const base = {
            lineNumber: index + 1,
            purchaseOrderItemId: poItem?.id ?? null,
            receiptItemId: line.receiptItemId ?? null,
            variantId:
              poItem?.variantId ??
              (line.receiptItemId
                ? (receiptItemById.get(line.receiptItemId)?.variantId ?? null)
                : null),
            description,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            subtotal,
            taxAmount,
            total: fromCents(toCents(subtotal) + toCents(taxAmount)),
          };
          if (!poItem) {
            return {
              ...base,
              expectedUnitPrice: null,
              matchableQuantity: null,
              priceVariance: 0,
              priceVariancePercent: null,
              quantityVariance: 0,
              varianceFlag: false,
              reasons: [] as string[],
            };
          }
          const already = addQty(
            invoicedElsewhere.get(poItem.id) ?? 0,
            usedHere.get(poItem.id) ?? 0,
          );
          const matchable = Math.max(
            0,
            subQty(poItem.quantityReceived, already),
          );
          usedHere.set(
            poItem.id,
            addQty(usedHere.get(poItem.id) ?? 0, line.quantity),
          );
          const expected = netUnitCost(poItem);
          const match = matchInvoiceLine(
            {
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              expectedUnitPrice: expected,
              matchableQuantity: matchable,
            },
            tolerance,
          );
          return {
            ...base,
            expectedUnitPrice: expected,
            matchableQuantity: matchable,
            priceVariance: match.priceVariance,
            priceVariancePercent: match.priceVariancePercent,
            quantityVariance: match.quantityVariance,
            varianceFlag: match.flagged,
            reasons: match.reasons,
          };
        });

        const subtotalCents = lines.reduce(
          (s, l) => s + toCents(l.subtotal),
          0,
        );
        const taxCents = lines.reduce((s, l) => s + toCents(l.taxAmount), 0);
        if (subtotalCents + taxCents <= 0) {
          throw new BadRequestException('The invoice total must be positive');
        }
        const hasVariance = lines.some((l) => l.varianceFlag);
        const invoice = await manager.save(
          manager.create(SupplierInvoice, {
            tenantId,
            supplierId: supplier.id,
            invoiceNumber,
            invoiceType: 'standard',
            purchaseOrderId: po?.id ?? null,
            invoiceDate,
            dueDate,
            currencyCode:
              po?.currencyCode ??
              supplier.currencyCode ??
              settings.currencyCode,
            subtotal: fromCents(subtotalCents),
            taxAmount: fromCents(taxCents),
            total: fromCents(subtotalCents + taxCents),
            status: hasVariance ? 'pending_approval' : 'open',
            hasVariance,
            notes: dto.notes ?? null,
            userId,
          }),
        );
        await manager.insert(
          SupplierInvoiceItem,
          lines.map((line) => {
            const { reasons, ...values } = line;
            void reasons;
            return { ...values, tenantId, invoiceId: invoice.id };
          }),
        );
        await this.auditService.record(
          {
            tenantId,
            action: 'supplier_invoice.created',
            entityType: 'supplier_invoice',
            entityId: invoice.id,
            metadata: {
              invoiceNumber,
              supplierId: supplier.id,
              purchaseOrderId: po?.id ?? null,
              total: invoice.total,
              status: invoice.status,
              tolerancePercent: tolerance,
              variances: lines
                .filter((l) => l.varianceFlag)
                .map((l) => ({
                  lineNumber: l.lineNumber,
                  priceVariance: l.priceVariance,
                  priceVariancePercent: l.priceVariancePercent,
                  quantityVariance: l.quantityVariance,
                  reasons: l.reasons,
                })),
            },
          },
          manager,
        );
        return invoice.id;
      });
      return this.get(tenantId, id);
    } catch (error) {
      // Two people entering the same invoice at once
      if (
        isPgError(error, PG_UNIQUE_VIOLATION, 'uq_supplier_invoices_number')
      ) {
        throw new ConflictException(DUPLICATE_MESSAGE);
      }
      throw error;
    }
  }

  /**
   * Approve an invoice held for variances (someone other than who entered it)
   */
  async approve(tenantId: string, id: string, approverId: string) {
    await this.dataSource.transaction(async (manager) => {
      const invoice = await this.lock(manager, tenantId, id);
      if (invoice.status !== 'pending_approval') {
        throw new BadRequestException(
          'This invoice is not waiting for approval',
        );
      }
      if (invoice.userId === approverId) {
        throw new BadRequestException(
          'An invoice must be approved by someone other than the person who entered it',
        );
      }
      invoice.status = 'open';
      invoice.approvedById = approverId;
      invoice.approvedAt = new Date();
      await manager.save(invoice);
      await this.auditService.record(
        {
          tenantId,
          action: 'supplier_invoice.approved',
          entityType: 'supplier_invoice',
          entityId: invoice.id,
          approverId,
          metadata: {
            invoiceNumber: invoice.invoiceNumber,
            supplierId: invoice.supplierId,
            total: invoice.total,
          },
        },
        manager,
      );
    });
    return this.get(tenantId, id);
  }

  /** Void an invoice entered by mistake (nothing may be allocated to it) */
  async void(tenantId: string, id: string, reason: string) {
    await this.dataSource.transaction(async (manager) => {
      const invoice = await this.lock(manager, tenantId, id);
      if (invoice.status === 'void') {
        throw new BadRequestException('This invoice is already void');
      }
      const allocations = await manager.count(SupplierAllocation, {
        where: { tenantId, invoiceId: id },
      });
      if (allocations > 0) {
        throw new BadRequestException(
          'Payments or credits are allocated to this invoice; void those first',
        );
      }
      const from = invoice.status;
      invoice.status = 'void';
      invoice.voidedAt = new Date();
      invoice.voidReason = reason;
      await manager.save(invoice);
      await this.auditService.record(
        {
          tenantId,
          action: 'supplier_invoice.voided',
          entityType: 'supplier_invoice',
          entityId: invoice.id,
          reason,
          metadata: {
            invoiceNumber: invoice.invoiceNumber,
            supplierId: invoice.supplierId,
            total: invoice.total,
            from,
          },
        },
        manager,
      );
    });
    return this.get(tenantId, id);
  }

  /**
   * Same supplier, same number (case-insensitive), not void → conflict
   */
  async assertNotDuplicate(
    manager: EntityManager,
    tenantId: string,
    supplierId: string,
    invoiceNumber: string,
  ) {
    const existing = await manager
      .getRepository(SupplierInvoice)
      .createQueryBuilder('inv')
      .where('inv.tenantId = :tenantId AND inv.supplierId = :supplierId', {
        tenantId,
        supplierId,
      })
      .andWhere('lower(inv.invoiceNumber) = lower(:invoiceNumber)', {
        invoiceNumber,
      })
      .andWhere("inv.status <> 'void'")
      .getOne();
    if (existing) {
      throw new ConflictException(DUPLICATE_MESSAGE);
    }
  }

  /** Quantity already invoiced per order line (invoices not void) */
  private async invoicedQuantities(
    manager: EntityManager,
    tenantId: string,
    poItemIds: string[],
  ): Promise<Map<string, number>> {
    if (poItemIds.length === 0) return new Map();
    const rows = await manager
      .getRepository(SupplierInvoiceItem)
      .createQueryBuilder('item')
      .innerJoin('item.invoice', 'inv')
      .select('item.purchaseOrderItemId', 'id')
      .addSelect('COALESCE(SUM(item.quantity), 0)', 'quantity')
      .where('item.tenantId = :tenantId', { tenantId })
      .andWhere('item.purchaseOrderItemId IN (:...poItemIds)', { poItemIds })
      .andWhere("inv.status <> 'void'")
      .groupBy('item.purchaseOrderItemId')
      .getRawMany<{ id: string; quantity: string | number }>();
    return new Map(rows.map((r) => [r.id, Number(r.quantity)]));
  }

  private async lock(manager: EntityManager, tenantId: string, id: string) {
    const invoice = await manager.findOne(SupplierInvoice, {
      where: { tenantId, id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!invoice) throw new NotFoundException('Supplier invoice not found');
    return invoice;
  }

  private withAmounts(
    invoice: SupplierInvoice,
    allocated: Map<string, number>,
  ) {
    const paid = fromCents(toCents(allocated.get(invoice.id) ?? 0));
    const open =
      invoice.status === 'void'
        ? 0
        : fromCents(toCents(invoice.total) - toCents(paid));
    const today = isoDate(new Date());
    return {
      ...invoice,
      amountAllocated: paid,
      amountOpen: open,
      overdue: open > 0 && invoice.dueDate < today,
    };
  }
}
