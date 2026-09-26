import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import {
  assertLocationAccess,
  canAccessLocation,
  locationFilterSql,
} from '../auth/branch-scope';
import {
  PurchaseOrder,
  PurchaseOrderStatus,
} from '../database/entities/purchase-order.entity';
import { PurchaseOrderItem } from '../database/entities/purchase-order-item.entity';
import {
  PurchaseOrderRevision,
  PurchaseOrderSnapshot,
  PurchaseOrderSnapshotLine,
} from '../database/entities/purchase-order-revision.entity';
import { Supplier, SupplierStatus } from '../database/entities/supplier.entity';
import { SupplierProduct } from '../database/entities/supplier-product.entity';
import { InventoryLocation } from '../database/entities/inventory-location.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { GoodsReceipt } from '../database/entities/goods-receipt.entity';
import {
  GoodsReceiptItem,
  ReceiptCondition,
} from '../database/entities/goods-receipt-item.entity';
import { SupplierInvoiceItem } from '../database/entities/supplier-invoice-item.entity';
import { MovementType } from '../database/entities/stock-movement.entity';
import { User } from '../database/entities/user.entity';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { SettingsService } from '../settings/settings.service';
import { InventoryService } from '../inventory/inventory.service';
import { OutboxService } from '../platform/outbox/outbox.service';
import { approvalRequired } from '../sales/sale-authorization';
import { nextDocumentNumber } from '../common/utils/sequence';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { lineAmount, sumMoney } from './money';
import { assertUnitQuantities } from '../products/variant-units';
import { addQty, subQty } from '../common/utils/quantity';
import { resolveOptionalApprover } from './authorize';
import {
  computeOrderTotals,
  netUnitCost,
  planReceipt,
  planShortClose,
  PurchaseOrderAction,
  revisionError,
  statusAfterReceipt,
  statusAfterRevision,
  statusAfterSubmit,
  transitionError,
} from './purchase-order.logic';
import {
  PurchaseOrdersQueryDto,
  ReceiptsQueryDto,
  ReceivePurchaseOrderDto,
  RevisePurchaseOrderDto,
  SavePurchaseOrderDto,
  UnplannedReceiptDto,
} from './purchasing.dto';
import { containsPattern } from '../common/utils/like';

// Display name of a variant: "Product" or "Product – Variant"
export function variantDisplayName(
  productName: Record<string, string> | null | undefined,
  variantName: Record<string, string> | null | undefined,
): string {
  const pick = (value: Record<string, string> | null | undefined) =>
    value ? (value.en ?? Object.values(value)[0] ?? '') : '';
  const product = pick(productName);
  const variant = pick(variantName);
  return variant && variant !== product
    ? `${product} – ${variant}`
    : product || variant;
}

export interface ReceiveResult {
  // True when this idempotency key was already used: nothing was posted again
  duplicate: boolean;
  receipt: GoodsReceipt;
  purchaseOrder: PurchaseOrder | null;
}

// Who is receiving, and a manager's approval token for an over-receipt
export interface ReceiveAuth {
  user: Pick<AuthUser, 'id' | 'tenantId' | 'permissions'>;
  approvalToken?: string;
}

// A line as it should be on the order (create, revise, revert)
type DesiredLine = Omit<PurchaseOrderSnapshotLine, 'quantityReceived'>;

const OVER_RECEIPT_MESSAGE =
  'This delivery is more than the order allows (over-receipt tolerance). Someone with "Approve purchase orders" must authorise it.';

@Injectable()
export class PurchaseOrdersService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
    private settingsService: SettingsService,
    private inventoryService: InventoryService,
    @Optional() private approvalsService?: ApprovalsService,
    @Optional() private outbox?: OutboxService,
  ) {}

  async list(tenantId: string, query: PurchaseOrdersQueryDto) {
    const qb = this.dataSource
      .getRepository(PurchaseOrder)
      .createQueryBuilder('po')
      .leftJoinAndSelect('po.supplier', 'supplier')
      .leftJoinAndSelect('po.location', 'location')
      .where('po.tenantId = :tenantId', { tenantId })
      .orderBy('po.created_at', 'DESC')
      .take(200);
    if (query.status) {
      qb.andWhere('po.status = :status', { status: query.status });
    }
    if (query.supplierId) {
      qb.andWhere('po.supplierId = :supplierId', {
        supplierId: query.supplierId,
      });
    }
    if (query.search) {
      qb.andWhere(
        '(po.poNumber ILIKE :search OR supplier.name ILIKE :search OR po.supplierReference ILIKE :search)',
        {
          search: containsPattern(query.search),
        },
      );
    }
    // Branch-limited users: orders received at their branches' locations (spec §9)
    const scope = locationFilterSql('"po"."locationId"');
    if (scope) qb.andWhere(scope.sql, scope.params);
    return qb.getMany();
  }

  /**
   * One order with its lines, receipts, revisions and the people involved (for
   * the detail and printable views)
   */
  async get(tenantId: string, id: string, manager?: EntityManager) {
    const em = manager ?? this.dataSource.manager;
    const po = await em
      .getRepository(PurchaseOrder)
      .createQueryBuilder('po')
      .leftJoinAndSelect('po.supplier', 'supplier')
      .leftJoinAndSelect('po.location', 'location')
      .leftJoinAndSelect('po.warehouse', 'warehouse')
      .leftJoinAndSelect('po.items', 'item')
      .where('po.tenantId = :tenantId AND po.id = :id', { tenantId, id })
      .orderBy('item.lineNumber', 'ASC')
      .getOne();
    if (!po || !(await canAccessLocation(em, tenantId, po.locationId))) {
      throw new NotFoundException('Purchase order not found');
    }

    const receipts = await em.find(GoodsReceipt, {
      where: { tenantId, purchaseOrderId: id },
      relations: { items: true },
      order: { receivedAt: 'ASC' },
    });
    const revisions = await em.find(PurchaseOrderRevision, {
      where: { tenantId, purchaseOrderId: id },
      order: { revisionNumber: 'DESC' },
    });
    const userIds = [
      po.userId,
      po.approvedById,
      ...receipts.map((r) => r.userId),
      ...receipts.map((r) => r.overReceiptApprovedById),
      ...revisions.map((r) => r.userId),
    ].filter((u): u is string => !!u);
    const users = userIds.length
      ? await em.find(User, {
          where: { id: In([...new Set(userIds)]) },
          select: { id: true, firstName: true, lastName: true, email: true },
        })
      : [];
    const people = Object.fromEntries(
      users.map((u) => [
        u.id,
        [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
      ]),
    );
    return {
      ...po,
      receipts,
      revisions,
      createdByName: people[po.userId] ?? null,
      approvedByName: po.approvedById ? people[po.approvedById] : null,
      people,
    };
  }

  async create(tenantId: string, userId: string, dto: SavePurchaseOrderDto) {
    const { supplier, location, lines } = await this.resolveOrderInput(
      tenantId,
      dto,
    );
    const { currencyCode } = await this.settingsService.getSettings(tenantId);
    const id = await this.dataSource.transaction(async (manager) => {
      const poNumber = await nextDocumentNumber(manager, {
        table: 'purchase_orders',
        column: 'poNumber',
        tenantId,
        prefix: 'PO',
      });
      const totals = computeOrderTotals(
        dto.items,
        dto.taxAmount,
        dto.shippingCost,
      );
      const po = await manager.save(
        manager.create(PurchaseOrder, {
          tenantId,
          poNumber,
          supplierId: supplier.id,
          locationId: location.id,
          warehouseId: location.warehouseId,
          expectedDeliveryDate: dto.expectedDeliveryDate
            ? new Date(dto.expectedDeliveryDate)
            : undefined,
          subtotal: totals.subtotal,
          discountAmount: totals.discountAmount,
          taxAmount: totals.taxAmount,
          shippingCost: totals.shippingCost,
          total: totals.total,
          currencyCode: supplier.currencyCode ?? currencyCode,
          userId,
          notes: dto.notes ?? undefined,
          supplierReference: dto.supplierReference ?? null,
          status: PurchaseOrderStatus.DRAFT,
        }),
      );
      await this.syncLines(manager, po, [], this.desiredLines(lines, totals));
      await this.auditService.record(
        {
          tenantId,
          action: 'purchase_order.created',
          entityType: 'purchase_order',
          entityId: po.id,
          metadata: {
            poNumber,
            supplierId: supplier.id,
            total: totals.total,
            lines: dto.items.length,
          },
        },
        manager,
      );
      return po.id;
    });
    return this.get(tenantId, id);
  }

  /**
   * Replace a draft's header and lines
   */
  async update(tenantId: string, id: string, dto: SavePurchaseOrderDto) {
    const { supplier, location, lines } = await this.resolveOrderInput(
      tenantId,
      dto,
    );
    await this.dataSource.transaction(async (manager) => {
      const po = await this.lockOrder(manager, tenantId, id, 'edit');
      const before = {
        supplierId: po.supplierId,
        locationId: po.locationId,
        total: po.total,
      };
      const totals = computeOrderTotals(
        dto.items,
        dto.taxAmount,
        dto.shippingCost,
      );
      this.applyHeader(po, dto, totals);
      po.supplierId = supplier.id;
      po.locationId = location.id;
      po.warehouseId = location.warehouseId;
      if (supplier.currencyCode) po.currencyCode = supplier.currencyCode;
      await manager.save(po);
      const items = await manager.find(PurchaseOrderItem, {
        where: { tenantId, purchaseOrderId: po.id },
      });
      await this.syncLines(
        manager,
        po,
        items,
        this.desiredLines(lines, totals),
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'purchase_order.updated',
          entityType: 'purchase_order',
          entityId: po.id,
          changes: {
            before,
            after: {
              supplierId: po.supplierId,
              locationId: po.locationId,
              total: po.total,
            },
          },
          metadata: { poNumber: po.poNumber },
        },
        manager,
      );
    });
    return this.get(tenantId, id);
  }

  /**
   * Change an order after approval (approved, issued or partly received). The
   * change is recorded as a revision (before / after); when the new total is
   * above the approval threshold the order goes back for approval.
   */
  async revise(
    tenantId: string,
    userId: string,
    id: string,
    dto: RevisePurchaseOrderDto,
  ) {
    const { location, lines } = await this.resolveOrderInput(tenantId, dto, {
      allowInactiveSupplier: true,
    });
    const { purchaseApprovalThreshold } =
      await this.settingsService.getSettings(tenantId);
    await this.dataSource.transaction(async (manager) => {
      const po = await this.lockOrder(manager, tenantId, id, 'revise');
      if (dto.supplierId !== po.supplierId) {
        throw new BadRequestException(
          'The supplier of an approved order cannot be changed; cancel it and create a new order',
        );
      }
      const items = await manager.find(PurchaseOrderItem, {
        where: { tenantId, purchaseOrderId: po.id },
        order: { lineNumber: 'ASC' },
      });
      const anyReceived = items.some((i) => i.quantityReceived > 0);
      if (anyReceived && dto.locationId !== po.locationId) {
        throw new BadRequestException(
          'Goods were already received at this location; it cannot be changed',
        );
      }
      const error = revisionError(items, dto.items);
      if (error) throw new BadRequestException(error);

      const before = this.snapshot(po, items);
      const statusBefore = po.status;
      const totals = computeOrderTotals(
        dto.items,
        dto.taxAmount,
        dto.shippingCost,
      );
      this.applyHeader(po, dto, totals);
      po.locationId = location.id;
      po.warehouseId = location.warehouseId;
      const updated = await this.syncLines(
        manager,
        po,
        items,
        this.desiredLines(lines, totals),
      );
      const { status, requiresApproval } = statusAfterRevision(
        statusBefore,
        totals.total,
        purchaseApprovalThreshold,
        updated,
      );
      po.status = status;
      po.revisionNumber += 1;
      po.revisedById = userId;
      if (requiresApproval) {
        po.submittedAt = new Date();
        po.approvedAt = null;
        po.approvedById = null;
      }
      if (status === PurchaseOrderStatus.RECEIVED) po.receivedAt = new Date();
      await manager.save(po);

      const revision = await manager.save(
        manager.create(PurchaseOrderRevision, {
          tenantId,
          purchaseOrderId: po.id,
          revisionNumber: po.revisionNumber,
          userId,
          reason: dto.reason,
          statusBefore,
          statusAfter: status,
          totalBefore: before.total,
          totalAfter: totals.total,
          requiresApproval,
          before,
          after: this.snapshot(po, updated),
        }),
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'purchase_order.revised',
          entityType: 'purchase_order',
          entityId: po.id,
          reason: dto.reason,
          changes: { before, after: revision.after },
          metadata: {
            poNumber: po.poNumber,
            revisionNumber: po.revisionNumber,
            revisionId: revision.id,
            statusBefore,
            status,
            requiresApproval,
            threshold: purchaseApprovalThreshold,
          },
        },
        manager,
      );
    });
    return this.get(tenantId, id);
  }

  /**
   * draft → pending_approval (total above the threshold) or approved
   */
  async submit(tenantId: string, id: string) {
    const { purchaseApprovalThreshold } =
      await this.settingsService.getSettings(tenantId);
    await this.dataSource.transaction(async (manager) => {
      const po = await this.lockOrder(manager, tenantId, id, 'submit');
      const status = statusAfterSubmit(
        Number(po.total),
        purchaseApprovalThreshold,
      );
      po.status = status;
      po.submittedAt = new Date();
      if (status === PurchaseOrderStatus.APPROVED) {
        // Below the threshold: approved automatically (no approver)
        po.approvedAt = new Date();
        po.approvedById = null;
      }
      await manager.save(po);
      await this.auditService.record(
        {
          tenantId,
          action: 'purchase_order.submitted',
          entityType: 'purchase_order',
          entityId: po.id,
          metadata: {
            poNumber: po.poNumber,
            total: po.total,
            threshold: purchaseApprovalThreshold,
            status,
            autoApproved: status === PurchaseOrderStatus.APPROVED,
          },
        },
        manager,
      );
    });
    return this.get(tenantId, id);
  }

  /**
   * pending_approval → approved. `approverId` has already been checked to
   * differ from the creator, or from whoever made the pending revision (see
   * resolveDistinctApprover).
   */
  async approve(tenantId: string, id: string, approverId: string) {
    await this.dataSource.transaction(async (manager) => {
      const po = await this.lockOrder(manager, tenantId, id, 'approve');
      if (approverId === PurchaseOrdersService.requesterOf(po)) {
        throw new BadRequestException(
          po.revisedById
            ? 'A revised purchase order must be approved by someone other than the person who revised it'
            : 'A purchase order must be approved by someone other than its creator',
        );
      }
      po.status = PurchaseOrderStatus.APPROVED;
      po.approvedById = approverId;
      po.approvedAt = new Date();
      await manager.save(po);
      await this.auditService.record(
        {
          tenantId,
          action: 'purchase_order.approved',
          entityType: 'purchase_order',
          entityId: po.id,
          approverId,
          metadata: {
            poNumber: po.poNumber,
            total: po.total,
            createdBy: po.userId,
            revisionNumber: po.revisionNumber,
          },
        },
        manager,
      );
    });
    return this.get(tenantId, id);
  }

  /** The person who may not approve the order: its latest reviser, else its creator */
  static requesterOf(po: Pick<PurchaseOrder, 'userId' | 'revisedById'>) {
    return po.revisedById ?? po.userId;
  }

  /**
   * pending_approval → draft, so the creator can change it. A pending revision
   * is undone instead: the order returns to what it was before the revision.
   */
  async reject(tenantId: string, id: string, reason?: string) {
    await this.dataSource.transaction(async (manager) => {
      const po = await this.lockOrder(manager, tenantId, id, 'reject');
      const revision =
        po.revisionNumber > 0
          ? await manager.findOne(PurchaseOrderRevision, {
              where: {
                tenantId,
                purchaseOrderId: po.id,
                revisionNumber: po.revisionNumber,
                rejectedAt: IsNull(),
              },
            })
          : null;
      if (revision?.requiresApproval) {
        await this.revertRevision(manager, po, revision);
        await this.auditService.record(
          {
            tenantId,
            action: 'purchase_order.revision_rejected',
            entityType: 'purchase_order',
            entityId: po.id,
            reason: reason ?? null,
            metadata: {
              poNumber: po.poNumber,
              revisionNumber: revision.revisionNumber,
              status: po.status,
            },
          },
          manager,
        );
        return;
      }
      po.status = PurchaseOrderStatus.DRAFT;
      po.submittedAt = null;
      await manager.save(po);
      await this.auditService.record(
        {
          tenantId,
          action: 'purchase_order.rejected',
          entityType: 'purchase_order',
          entityId: po.id,
          reason: reason ?? null,
          metadata: { poNumber: po.poNumber },
        },
        manager,
      );
    });
    return this.get(tenantId, id);
  }

  /**
   * approved → issued (sent to the supplier). A re-approved revision of an
   * order that already received goods goes back to partly received.
   */
  async issue(tenantId: string, id: string) {
    await this.dataSource.transaction(async (manager) => {
      const po = await this.lockOrder(manager, tenantId, id, 'issue');
      const items = await manager.find(PurchaseOrderItem, {
        where: { tenantId, purchaseOrderId: po.id },
      });
      po.status = statusAfterReceipt(items);
      if (po.status === PurchaseOrderStatus.RECEIVED)
        po.receivedAt = new Date();
      po.issuedAt = new Date();
      await manager.save(po);
      await this.auditService.record(
        {
          tenantId,
          action: 'purchase_order.issued',
          entityType: 'purchase_order',
          entityId: po.id,
          metadata: {
            poNumber: po.poNumber,
            supplierId: po.supplierId,
            revisionNumber: po.revisionNumber,
          },
        },
        manager,
      );
    });
    return this.get(tenantId, id);
  }

  /**
   * Cancel an order that has not received anything yet
   */
  async cancel(tenantId: string, id: string, reason?: string) {
    await this.dataSource.transaction(async (manager) => {
      const po = await this.lockOrder(manager, tenantId, id, 'cancel');
      const received = await manager.sum(
        PurchaseOrderItem,
        'quantityReceived',
        {
          tenantId,
          purchaseOrderId: po.id,
        },
      );
      if ((received ?? 0) > 0) {
        throw new BadRequestException(
          'Goods were already received on this order; short-close it instead',
        );
      }
      const from = po.status;
      po.status = PurchaseOrderStatus.CANCELLED;
      po.cancelledAt = new Date();
      po.cancelReason = reason ?? null;
      await manager.save(po);
      await this.auditService.record(
        {
          tenantId,
          action: 'purchase_order.cancelled',
          entityType: 'purchase_order',
          entityId: po.id,
          reason: reason ?? null,
          metadata: { poNumber: po.poNumber, from },
        },
        manager,
      );
    });
    return this.get(tenantId, id);
  }

  /**
   * Close the order. Partly received: short-close — what was not received is
   * cancelled (no longer expected); received goods and stock are untouched.
   */
  async close(tenantId: string, id: string, reason: string) {
    await this.dataSource.transaction(async (manager) => {
      const po = await this.lockOrder(manager, tenantId, id, 'close');
      const items = await manager.find(PurchaseOrderItem, {
        where: { tenantId, purchaseOrderId: po.id },
        order: { lineNumber: 'ASC' },
      });
      const cancelled = planShortClose(items);
      for (const { itemId, cancel } of cancelled) {
        await manager.increment(
          PurchaseOrderItem,
          { id: itemId, tenantId },
          'quantityCancelled',
          cancel,
        );
      }
      const from = po.status;
      po.status = PurchaseOrderStatus.CLOSED;
      po.closedAt = new Date();
      po.closeReason = reason;
      await manager.save(po);
      const byId = new Map(items.map((i) => [i.id, i]));
      await this.auditService.record(
        {
          tenantId,
          action:
            cancelled.length > 0
              ? 'purchase_order.short_closed'
              : 'purchase_order.closed',
          entityType: 'purchase_order',
          entityId: po.id,
          reason,
          metadata: {
            poNumber: po.poNumber,
            from,
            cancelled: cancelled.map((c) => ({
              variantId: byId.get(c.itemId)?.variantId,
              sku: byId.get(c.itemId)?.sku,
              quantity: c.cancel,
            })),
          },
        },
        manager,
      );
    });
    return this.get(tenantId, id);
  }

  /**
   * Receive a delivery (all or part of what is outstanding) into the order's
   * location. Good units go into sellable stock, accepted damaged units into the
   * warehouse's damaged / quarantine location; rejected damaged units are only
   * recorded. Receiving more than the over-receipt
   * tolerance needs purchasing.approve (or a manager's approval token).
   * Idempotent per idempotencyKey: a retry returns the first receipt and posts
   * nothing.
   */
  async receive(
    tenantId: string,
    userId: string,
    id: string,
    dto: ReceivePurchaseOrderDto,
    auth?: ReceiveAuth,
  ): Promise<ReceiveResult> {
    const replay = await this.findReceiptByKey(
      this.dataSource.manager,
      tenantId,
      id,
      dto.idempotencyKey,
    );
    if (replay) return replay;

    const settings = await this.settingsService.getSettings(tenantId);
    const tolerance = settings?.purchaseOverReceiptTolerance ?? 0;
    // Resolved up front (verifying a token claims it); used only if needed
    const overApproverId = auth
      ? await resolveOptionalApprover(
          this.approvalsService,
          auth.user,
          'purchasing.approve',
          auth.approvalToken,
        )
      : null;

    try {
      return await this.dataSource.transaction(async (manager) => {
        // Serialises receipts of the same order (outstanding quantities)
        const po = await manager.findOne(PurchaseOrder, {
          where: { tenantId, id },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          !po ||
          !(await canAccessLocation(manager, tenantId, po.locationId))
        ) {
          throw new NotFoundException('Purchase order not found');
        }

        // Same key committed while we waited for the lock
        const again = await this.findReceiptByKey(
          manager,
          tenantId,
          id,
          dto.idempotencyKey,
        );
        if (again) return again;

        const error = transitionError(po.status, 'receive');
        if (error) throw new BadRequestException(error);

        const items = await manager.find(PurchaseOrderItem, {
          where: { tenantId, purchaseOrderId: po.id },
          order: { lineNumber: 'ASC' },
        });
        const variantOf = new Map(items.map((i) => [i.id, i.variantId]));
        await assertUnitQuantities(
          manager,
          tenantId,
          dto.items.flatMap((l) => {
            const variantId = variantOf.get(l.purchaseOrderItemId);
            return variantId
              ? [
                  { variantId, quantity: l.quantity },
                  { variantId, quantity: l.damagedQuantity ?? 0 },
                ]
              : [];
          }),
          { allowZero: true },
        );
        const plan = planReceipt(
          items.map((i) => ({
            id: i.id,
            variantId: i.variantId,
            quantityOrdered: i.quantityOrdered,
            quantityReceived: i.quantityReceived,
            quantityCancelled: i.quantityCancelled ?? 0,
            unitCost: netUnitCost(i),
          })),
          dto.items,
          tolerance,
        );
        if ('error' in plan) throw new BadRequestException(plan.error);
        const overTolerance = plan.overTolerance.length > 0;
        if (overTolerance && !overApproverId) {
          throw approvalRequired('purchasing.approve', OVER_RECEIPT_MESSAGE);
        }

        const receipt = await this.createReceipt(manager, {
          tenantId,
          userId,
          supplierId: po.supplierId,
          purchaseOrderId: po.id,
          locationId: po.locationId,
          dto,
          overReceiptApprovedById: overTolerance ? overApproverId : null,
          lines: plan.lines.map((l) => ({
            purchaseOrderItemId: l.item.id,
            variantId: l.item.variantId,
            quantity: l.quantity,
            damagedQuantity: l.damagedQuantity,
            damagedAccepted: l.damagedAccepted,
            unitCost: l.unitCost,
          })),
          notes: `${po.poNumber}${dto.reference ? ` / ${dto.reference}` : ''}`,
        });

        const byId = new Map(items.map((i) => [i.id, i]));
        for (const line of plan.lines) {
          if (line.stockQuantity === 0) continue;
          await manager.increment(
            PurchaseOrderItem,
            { id: line.item.id, tenantId },
            'quantityReceived',
            line.stockQuantity,
          );
          const item = byId.get(line.item.id)!;
          item.quantityReceived = addQty(
            item.quantityReceived,
            line.stockQuantity,
          );
        }

        const from = po.status;
        po.status = statusAfterReceipt(items);
        if (po.status === PurchaseOrderStatus.RECEIVED) {
          po.receivedAt = new Date();
        }
        await manager.save(po);

        await this.auditService.record(
          {
            tenantId,
            action: 'purchase_order.received',
            entityType: 'purchase_order',
            entityId: po.id,
            approverId: overTolerance ? overApproverId : undefined,
            metadata: {
              poNumber: po.poNumber,
              receiptNumber: receipt.receiptNumber,
              receiptId: receipt.id,
              reference: dto.reference ?? null,
              from,
              status: po.status,
              overReceipt: plan.overTolerance,
              tolerancePercent: tolerance,
              lines: plan.lines.map((l) => ({
                variantId: l.item.variantId,
                quantity: l.quantity,
                damagedQuantity: l.damagedQuantity,
                damagedAccepted: l.damagedAccepted,
                unitCost: l.unitCost,
              })),
            },
          },
          manager,
        );

        return { duplicate: false, receipt, purchaseOrder: po };
      });
    } catch (error) {
      // A concurrent request with the same key won the race
      if (
        isPgError(error, PG_UNIQUE_VIOLATION, 'uq_goods_receipts_idempotency')
      ) {
        const winner = await this.findReceiptByKey(
          this.dataSource.manager,
          tenantId,
          id,
          dto.idempotencyKey,
        );
        if (winner) return winner;
      }
      throw error;
    }
  }

  /**
   * Receive goods from a supplier without a purchase order (needs
   * purchasing.receive.unplanned). Idempotent per idempotencyKey.
   */
  async receiveUnplanned(
    tenantId: string,
    userId: string,
    dto: UnplannedReceiptDto,
  ): Promise<ReceiveResult> {
    const replay = await this.findReceiptByKey(
      this.dataSource.manager,
      tenantId,
      null,
      dto.idempotencyKey,
    );
    if (replay) return replay;

    const supplier = await this.dataSource
      .getRepository(Supplier)
      .findOne({ where: { tenantId, id: dto.supplierId } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    if (supplier.status === SupplierStatus.BLOCKED) {
      throw new BadRequestException(
        `Supplier ${supplier.name} is blocked; goods cannot be received from it`,
      );
    }
    const location = await this.dataSource
      .getRepository(InventoryLocation)
      .findOne({ where: { tenantId, id: dto.locationId } });
    if (!location) throw new NotFoundException('Location not found');
    await assertLocationAccess(this.dataSource.manager, tenantId, location.id);
    const variantIds = dto.items.map((i) => i.variantId);
    if (new Set(variantIds).size !== variantIds.length) {
      throw new BadRequestException(
        'Each variant can only appear once per receipt',
      );
    }
    const found = await this.dataSource
      .getRepository(ProductVariant)
      .count({ where: { tenantId, id: In(variantIds) } });
    if (found !== variantIds.length) {
      throw new NotFoundException('One or more variants were not found');
    }
    await assertUnitQuantities(
      this.dataSource.manager,
      tenantId,
      dto.items.flatMap((i) => [
        { variantId: i.variantId, quantity: i.quantity },
        { variantId: i.variantId, quantity: i.damagedQuantity ?? 0 },
      ]),
      { allowZero: true },
    );
    const lines = dto.items.filter(
      (i) => i.quantity > 0 || (i.damagedQuantity ?? 0) > 0,
    );
    if (lines.length === 0) throw new BadRequestException('Nothing to receive');

    try {
      return await this.dataSource.transaction(async (manager) => {
        const receipt = await this.createReceipt(manager, {
          tenantId,
          userId,
          supplierId: supplier.id,
          purchaseOrderId: null,
          locationId: location.id,
          dto,
          overReceiptApprovedById: null,
          lines: lines.map((l) => ({
            purchaseOrderItemId: null,
            variantId: l.variantId,
            quantity: l.quantity,
            damagedQuantity: l.damagedQuantity ?? 0,
            damagedAccepted:
              (l.damagedQuantity ?? 0) > 0 && !!l.damagedAccepted,
            unitCost: l.unitCost,
          })),
          notes: `${supplier.code}${dto.reference ? ` / ${dto.reference}` : ''}`,
        });
        await this.auditService.record(
          {
            tenantId,
            action: 'goods_receipt.unplanned',
            entityType: 'goods_receipt',
            entityId: receipt.id,
            metadata: {
              receiptNumber: receipt.receiptNumber,
              supplierId: supplier.id,
              locationId: location.id,
              reference: dto.reference ?? null,
              totalCost: receipt.totalCost,
              lines: lines.map((l) => ({
                variantId: l.variantId,
                quantity: l.quantity,
                damagedQuantity: l.damagedQuantity ?? 0,
                damagedAccepted: !!l.damagedAccepted,
                unitCost: l.unitCost,
              })),
            },
          },
          manager,
        );
        return { duplicate: false, receipt, purchaseOrder: null };
      });
    } catch (error) {
      if (
        isPgError(error, PG_UNIQUE_VIOLATION, 'uq_goods_receipts_idempotency')
      ) {
        const winner = await this.findReceiptByKey(
          this.dataSource.manager,
          tenantId,
          null,
          dto.idempotencyKey,
        );
        if (winner) return winner;
      }
      throw error;
    }
  }

  /**
   * Receipts (goods received notes), newest first, with what can still be
   * returned on each line
   */
  async listReceipts(tenantId: string, query: ReceiptsQueryDto) {
    const qb = this.dataSource
      .getRepository(GoodsReceipt)
      .createQueryBuilder('receipt')
      .leftJoinAndSelect('receipt.supplier', 'supplier')
      .leftJoinAndSelect('receipt.purchaseOrder', 'po')
      .leftJoinAndSelect('receipt.items', 'item')
      .where('receipt.tenantId = :tenantId', { tenantId })
      .orderBy('receipt.receivedAt', 'DESC')
      .take(200);
    if (query.supplierId) {
      qb.andWhere('receipt.supplierId = :supplierId', {
        supplierId: query.supplierId,
      });
    }
    if (query.purchaseOrderId) {
      qb.andWhere('receipt.purchaseOrderId = :purchaseOrderId', {
        purchaseOrderId: query.purchaseOrderId,
      });
    }
    if (query.search) {
      qb.andWhere(
        '(receipt.receiptNumber ILIKE :search OR receipt.reference ILIKE :search OR po.poNumber ILIKE :search)',
        { search: containsPattern(query.search) },
      );
    }
    // Branch-limited users: receipts at their branches' locations (spec §9)
    const scope = locationFilterSql('"receipt"."locationId"');
    if (scope) qb.andWhere(scope.sql, scope.params);
    const receipts = await qb.getMany();
    return this.withVariantNames(tenantId, receipts);
  }

  async getReceipt(tenantId: string, id: string) {
    const receipt = await this.dataSource.getRepository(GoodsReceipt).findOne({
      where: { tenantId, id },
      relations: { items: true, supplier: true, purchaseOrder: true },
    });
    if (
      !receipt ||
      !(await canAccessLocation(
        this.dataSource.manager,
        tenantId,
        receipt.locationId,
      ))
    ) {
      throw new NotFoundException('Goods receipt not found');
    }
    const [withNames] = await this.withVariantNames(tenantId, [receipt]);
    return withNames;
  }

  // ---- Internals ----

  /**
   * Post a receipt: numbered header, one line per condition, stock for good
   * units (at the receipt's location) and accepted damaged units (at the
   * warehouse's damaged / quarantine location, else the receipt's location),
   * supplier's last cost updated, goods.received recorded in the outbox
   */
  private async createReceipt(
    manager: EntityManager,
    input: {
      tenantId: string;
      userId: string;
      supplierId: string;
      purchaseOrderId: string | null;
      locationId: string;
      dto: { idempotencyKey: string; reference?: string; notes?: string };
      overReceiptApprovedById: string | null;
      notes: string;
      lines: {
        purchaseOrderItemId: string | null;
        variantId: string;
        quantity: number;
        damagedQuantity: number;
        damagedAccepted: boolean;
        unitCost: number;
      }[];
    },
  ): Promise<GoodsReceipt> {
    const { tenantId, userId, dto } = input;
    const receiptNumber = await nextDocumentNumber(manager, {
      table: 'goods_receipts',
      column: 'receiptNumber',
      tenantId,
      prefix: 'GRN',
    });
    const stockQty = (l: (typeof input.lines)[number]) =>
      addQty(l.quantity, l.damagedAccepted ? l.damagedQuantity : 0);
    const totalCost = sumMoney(
      input.lines.map((l) => lineAmount(stockQty(l), l.unitCost)),
    );
    const receipt = await manager.save(
      manager.create(GoodsReceipt, {
        tenantId,
        receiptNumber,
        purchaseOrderId: input.purchaseOrderId,
        supplierId: input.supplierId,
        locationId: input.locationId,
        idempotencyKey: dto.idempotencyKey,
        reference: dto.reference ?? null,
        notes: dto.notes ?? null,
        totalCost,
        userId,
        overReceiptApprovedById: input.overReceiptApprovedById,
      }),
    );

    // Accepted damaged units never go to sellable stock
    const hasDamaged = input.lines.some(
      (l) => l.damagedAccepted && l.damagedQuantity > 0,
    );
    const damagedLocationId = hasDamaged
      ? await this.inventoryService.resolveConditionLocation(
          manager,
          tenantId,
          input.locationId,
          'damaged',
        )
      : input.locationId;

    for (const line of input.lines) {
      const intoStock = stockQty(line);
      const movement = {
        tenantId,
        userId,
        variantId: line.variantId,
        movementType: MovementType.PURCHASE,
        referenceType: 'goods_receipt',
        referenceId: receipt.id,
        referenceNumber: receiptNumber,
        cost: line.unitCost,
        notes: input.notes,
      };
      if (line.quantity > 0) {
        await this.inventoryService.applyMovement(manager, {
          ...movement,
          locationId: input.locationId,
          delta: line.quantity,
        });
      }
      if (line.damagedAccepted && line.damagedQuantity > 0) {
        await this.inventoryService.applyMovement(manager, {
          ...movement,
          locationId: damagedLocationId,
          delta: line.damagedQuantity,
          metadata: { condition: 'damaged' },
        });
      }
      const base = {
        tenantId,
        receiptId: receipt.id,
        purchaseOrderItemId: line.purchaseOrderItemId,
        variantId: line.variantId,
        unitCost: line.unitCost,
      };
      if (line.quantity > 0) {
        await manager.insert(GoodsReceiptItem, {
          ...base,
          quantity: line.quantity,
          condition: ReceiptCondition.GOOD,
          accepted: true,
        });
      }
      if (line.damagedQuantity > 0) {
        await manager.insert(GoodsReceiptItem, {
          ...base,
          quantity: line.damagedQuantity,
          condition: ReceiptCondition.DAMAGED,
          accepted: line.damagedAccepted,
        });
      }
      if (intoStock > 0) {
        await this.recordLastCost(
          manager,
          tenantId,
          input.supplierId,
          line.variantId,
          line.unitCost,
        );
      }
    }

    await this.outbox?.record(manager, {
      tenantId,
      type: 'goods.received',
      aggregateId: receipt.id,
      payload: {
        receiptId: receipt.id,
        purchaseOrderId: input.purchaseOrderId,
        locationId: input.locationId,
        lines: input.lines
          .filter((l) => stockQty(l) > 0)
          .map((l) => ({
            variantId: l.variantId,
            quantity: stockQty(l),
            unitCost: l.unitCost,
          })),
      },
    });

    return (await manager.findOne(GoodsReceipt, {
      where: { id: receipt.id, tenantId },
      relations: { items: true },
    }))!;
  }

  /** Supplier's last cost for the variant (creates the supplier product) */
  private async recordLastCost(
    manager: EntityManager,
    tenantId: string,
    supplierId: string,
    variantId: string,
    unitCost: number,
  ) {
    await manager.query(
      `INSERT INTO supplier_products (id, "tenantId", "supplierId", "variantId", "lastCost", created_at, updated_at)
       VALUES (uuid_generate_v4(), $1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT ("tenantId", "supplierId", "variantId")
       DO UPDATE SET "lastCost" = EXCLUDED."lastCost", updated_at = NOW()`,
      [tenantId, supplierId, variantId, unitCost],
    );
  }

  private async withVariantNames(tenantId: string, receipts: GoodsReceipt[]) {
    const variantIds = [
      ...new Set(
        receipts.flatMap((r) => (r.items ?? []).map((i) => i.variantId)),
      ),
    ];
    const variants = variantIds.length
      ? await this.dataSource.getRepository(ProductVariant).find({
          where: { tenantId, id: In(variantIds) },
          relations: { product: true },
        })
      : [];
    const byId = new Map(variants.map((v) => [v.id, v]));
    return receipts.map((receipt) => ({
      ...receipt,
      items: (receipt.items ?? []).map((item) => {
        const variant = byId.get(item.variantId);
        return {
          ...item,
          sku: variant?.sku ?? '',
          productName: variant
            ? variantDisplayName(variant.product?.name, variant.name)
            : '',
          // Units that went into stock and can still go back to the supplier
          returnable: item.accepted
            ? subQty(item.quantity, item.quantityReturned)
            : 0,
        };
      }),
    }));
  }

  private async findReceiptByKey(
    manager: EntityManager,
    tenantId: string,
    purchaseOrderId: string | null,
    idempotencyKey: string,
  ): Promise<ReceiveResult | null> {
    const receipt = await manager.findOne(GoodsReceipt, {
      where: { tenantId, idempotencyKey },
      relations: { items: true },
    });
    if (!receipt) return null;
    if ((receipt.purchaseOrderId ?? null) !== purchaseOrderId) {
      throw new ConflictException(
        'This idempotency key was already used for another receipt',
      );
    }
    const purchaseOrder = purchaseOrderId
      ? await manager.findOneOrFail(PurchaseOrder, {
          where: { tenantId, id: purchaseOrderId },
        })
      : null;
    return { duplicate: true, receipt, purchaseOrder };
  }

  private async lockOrder(
    manager: EntityManager,
    tenantId: string,
    id: string,
    action: PurchaseOrderAction,
  ): Promise<PurchaseOrder> {
    const po = await manager.findOne(PurchaseOrder, {
      where: { tenantId, id },
      lock: { mode: 'pessimistic_write' },
    });
    if (!po || !(await canAccessLocation(manager, tenantId, po.locationId))) {
      throw new NotFoundException('Purchase order not found');
    }
    const error = transitionError(po.status, action);
    if (error) throw new BadRequestException(error);
    return po;
  }

  private async resolveOrderInput(
    tenantId: string,
    dto: SavePurchaseOrderDto,
    options: { allowInactiveSupplier?: boolean } = {},
  ) {
    const supplier = await this.dataSource
      .getRepository(Supplier)
      .findOne({ where: { tenantId, id: dto.supplierId } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    if (
      supplier.status !== SupplierStatus.ACTIVE &&
      !(
        options.allowInactiveSupplier &&
        supplier.status === SupplierStatus.INACTIVE
      )
    ) {
      throw new BadRequestException(
        `Supplier ${supplier.name} is ${supplier.status}; activate it before ordering`,
      );
    }
    const location = await this.dataSource
      .getRepository(InventoryLocation)
      .findOne({ where: { tenantId, id: dto.locationId } });
    if (!location) throw new NotFoundException('Location not found');
    // Ordered for one of the user's branches (spec §9)
    await assertLocationAccess(this.dataSource.manager, tenantId, location.id);

    const variantIds = dto.items.map((i) => i.variantId);
    if (new Set(variantIds).size !== variantIds.length) {
      throw new BadRequestException(
        'Each variant can only appear once per order',
      );
    }
    const variants = await this.dataSource.getRepository(ProductVariant).find({
      where: { tenantId, id: In(variantIds) },
      relations: { product: true },
    });
    if (variants.length !== variantIds.length) {
      throw new NotFoundException('One or more variants were not found');
    }
    // Decimals only for measured items, up to their unit's precision
    await assertUnitQuantities(
      this.dataSource.manager,
      tenantId,
      dto.items.map((i) => ({
        variantId: i.variantId,
        quantity: i.quantityOrdered,
      })),
    );
    // The supplier's own codes prefill lines that do not give one
    const supplierProducts = await this.dataSource
      .getRepository(SupplierProduct)
      .find({
        where: { tenantId, supplierId: supplier.id, variantId: In(variantIds) },
      });
    const codes = new Map(
      supplierProducts.map((p) => [p.variantId, p.supplierSku]),
    );
    const byId = new Map(variants.map((v) => [v.id, v]));
    const lines = dto.items.map((item) => ({
      ...item,
      supplierSku:
        item.supplierSku !== undefined
          ? item.supplierSku
          : (codes.get(item.variantId) ?? null),
      variant: byId.get(item.variantId)!,
    }));
    return { supplier, location, lines };
  }

  private applyHeader(
    po: PurchaseOrder,
    dto: SavePurchaseOrderDto,
    totals: ReturnType<typeof computeOrderTotals>,
  ) {
    Object.assign(po, {
      expectedDeliveryDate: dto.expectedDeliveryDate
        ? new Date(dto.expectedDeliveryDate)
        : null,
      subtotal: totals.subtotal,
      discountAmount: totals.discountAmount,
      taxAmount: totals.taxAmount,
      shippingCost: totals.shippingCost,
      total: totals.total,
      notes: dto.notes ?? null,
      supplierReference: dto.supplierReference ?? null,
    });
  }

  private desiredLines(
    lines: (SavePurchaseOrderDto['items'][number] & {
      supplierSku: string | null;
      variant: ProductVariant;
    })[],
    totals: ReturnType<typeof computeOrderTotals>,
  ): DesiredLine[] {
    return lines.map((line, index) => ({
      variantId: line.variantId,
      sku: line.variant.sku,
      productName: variantDisplayName(
        line.variant.product?.name,
        line.variant.name,
      ).slice(0, 255),
      quantityOrdered: line.quantityOrdered,
      unitCost: line.unitCost,
      discountPercent: line.discountPercent ?? 0,
      discountAmount: totals.lines[index].discountAmount,
      subtotal: totals.lines[index].subtotal,
      taxAmount: totals.lines[index].taxAmount,
      total: totals.lines[index].total,
      unitOfMeasure: line.unitOfMeasure ?? null,
      supplierSku: line.supplierSku ?? null,
      notes: line.notes ?? null,
    }));
  }

  /**
   * Make the order's lines match `desired` (by variant): update in place (so
   * receipts and invoices keep pointing at them), add new ones, remove the rest.
   * A line with receipts or invoice lines cannot be removed.
   */
  private async syncLines(
    manager: EntityManager,
    po: PurchaseOrder,
    current: PurchaseOrderItem[],
    desired: DesiredLine[],
  ): Promise<PurchaseOrderItem[]> {
    const { tenantId } = po;
    const wanted = new Set(desired.map((d) => d.variantId));
    const removed = current.filter((item) => !wanted.has(item.variantId));
    if (removed.length) {
      const ids = removed.map((r) => r.id);
      const [receiptLines, invoiceLines] = await Promise.all([
        manager.count(GoodsReceiptItem, {
          where: { tenantId, purchaseOrderItemId: In(ids) },
        }),
        manager.count(SupplierInvoiceItem, {
          where: { tenantId, purchaseOrderItemId: In(ids) },
        }),
      ]);
      if (receiptLines > 0 || invoiceLines > 0) {
        throw new BadRequestException(
          'A line with receipts or invoices cannot be removed from the order',
        );
      }
      await manager.delete(PurchaseOrderItem, { tenantId, id: In(ids) });
    }
    const byVariant = new Map(current.map((i) => [i.variantId, i]));
    const result: PurchaseOrderItem[] = [];
    for (const [index, line] of desired.entries()) {
      const values = {
        sku: line.sku,
        productName: line.productName,
        quantityOrdered: line.quantityOrdered,
        unitCost: line.unitCost,
        discountPercent: line.discountPercent,
        discountAmount: line.discountAmount,
        subtotal: line.subtotal,
        taxAmount: line.taxAmount,
        total: line.total,
        unitOfMeasure: line.unitOfMeasure,
        supplierSku: line.supplierSku,
        notes: line.notes as string,
        lineNumber: index + 1,
      };
      const existing = byVariant.get(line.variantId);
      if (existing) {
        Object.assign(existing, values);
        result.push(await manager.save(existing));
      } else {
        result.push(
          await manager.save(
            manager.create(PurchaseOrderItem, {
              ...values,
              tenantId,
              purchaseOrderId: po.id,
              variantId: line.variantId,
              quantityReceived: 0,
              quantityCancelled: 0,
            }),
          ),
        );
      }
    }
    return result;
  }

  private snapshot(
    po: PurchaseOrder,
    items: PurchaseOrderItem[],
  ): PurchaseOrderSnapshot {
    const iso = (d: Date | string | null | undefined) =>
      d ? new Date(d).toISOString() : null;
    return {
      supplierId: po.supplierId,
      locationId: po.locationId,
      expectedDeliveryDate: iso(po.expectedDeliveryDate),
      supplierReference: po.supplierReference ?? null,
      subtotal: Number(po.subtotal),
      discountAmount: Number(po.discountAmount ?? 0),
      taxAmount: Number(po.taxAmount),
      shippingCost: Number(po.shippingCost),
      total: Number(po.total),
      notes: po.notes ?? null,
      approvedById: po.approvedById ?? null,
      approvedAt: iso(po.approvedAt),
      lines: [...items]
        .sort((a, b) => a.lineNumber - b.lineNumber)
        .map((i) => ({
          variantId: i.variantId,
          sku: i.sku,
          productName: i.productName,
          quantityOrdered: i.quantityOrdered,
          quantityReceived: i.quantityReceived,
          unitCost: Number(i.unitCost),
          discountPercent: Number(i.discountPercent ?? 0),
          discountAmount: Number(i.discountAmount ?? 0),
          subtotal: Number(i.subtotal),
          taxAmount: Number(i.taxAmount),
          total: Number(i.total),
          unitOfMeasure: i.unitOfMeasure ?? null,
          supplierSku: i.supplierSku ?? null,
          notes: i.notes ?? null,
        })),
    };
  }

  /** Undo a revision still waiting for approval: back to its `before` state */
  private async revertRevision(
    manager: EntityManager,
    po: PurchaseOrder,
    revision: PurchaseOrderRevision,
  ) {
    const before = revision.before;
    const items = await manager.find(PurchaseOrderItem, {
      where: { tenantId: po.tenantId, purchaseOrderId: po.id },
    });
    const restored = await this.syncLines(manager, po, items, before.lines);
    Object.assign(po, {
      locationId: before.locationId,
      expectedDeliveryDate: before.expectedDeliveryDate
        ? new Date(before.expectedDeliveryDate)
        : null,
      supplierReference: before.supplierReference,
      subtotal: before.subtotal,
      discountAmount: before.discountAmount,
      taxAmount: before.taxAmount,
      shippingCost: before.shippingCost,
      total: before.total,
      notes: before.notes,
      approvedById: before.approvedById,
      approvedAt: before.approvedAt ? new Date(before.approvedAt) : null,
      revisedById: null,
    });
    const statusBefore = revision.statusBefore as PurchaseOrderStatus;
    po.status =
      statusBefore === PurchaseOrderStatus.APPROVED
        ? statusBefore
        : statusAfterReceipt(restored);
    const location = await manager.findOne(InventoryLocation, {
      where: { tenantId: po.tenantId, id: before.locationId },
    });
    if (location) po.warehouseId = location.warehouseId;
    await manager.save(po);
    revision.rejectedAt = new Date();
    await manager.save(revision);
  }
}
