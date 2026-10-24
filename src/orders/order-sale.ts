import { ConflictException, NotFoundException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { canAccessBranch } from '../auth/branch-scope';
import {
  CustomerOrder,
  CustomerOrderStatus,
} from '../database/entities/customer-order.entity';
import { addQty } from '../common/utils/quantity';
import { AuditService } from '../audit/audit.service';
import { assertOrderActive, assertOrderTransition } from './order-rules';

/**
 * What SalesService needs to sell an order at pickup, without depending on
 * OrdersService (which prices orders through SalesService).
 */

export interface OrderQuote {
  order: CustomerOrder;
  // Per variant: the order's price/discount and the quantity ordered (all its lines)
  lines: Map<
    string,
    { unitPrice: number; discountPercent: number; quantity: number }
  >;
}

/** An order of the user's branches, or 404 (another branch's order is "not found") */
export async function findVisibleOrder(
  manager: EntityManager,
  tenantId: string,
  id: string,
  options: { lock?: boolean; items?: boolean } = {},
): Promise<CustomerOrder> {
  const order = await manager.findOne(CustomerOrder, {
    where: { id, tenantId },
    ...(options.items && { relations: { items: true } }),
    ...(options.lock && { lock: { mode: 'pessimistic_write' as const } }),
  });
  if (!order || !canAccessBranch(order.branchId)) {
    throw new NotFoundException('Order not found');
  }
  return order;
}

/**
 * The prices an order was taken at, for its pickup sale: the till sells it at
 * them without new approvals (like an estimate), for its customer only
 */
export async function orderQuotedLines(
  manager: EntityManager,
  tenantId: string,
  id: string,
): Promise<OrderQuote> {
  const order = await findVisibleOrder(manager, tenantId, id, { items: true });
  assertOrderActive(order);
  const lines: OrderQuote['lines'] = new Map();
  for (const item of order.items) {
    lines.set(item.variantId, {
      unitPrice: Number(item.unitPrice),
      discountPercent: Number(item.discountPercent),
      quantity: addQty(
        lines.get(item.variantId)?.quantity ?? 0,
        Number(item.quantity),
      ),
    });
  }
  return { order, lines };
}

/**
 * Lock the order its pickup sale is selling until the sale's transaction ends.
 * Refused when it was picked up or cancelled meanwhile, or when its deposits
 * changed since the sale was priced (the deposit tender must match them).
 */
export async function lockOrderForPickup(
  manager: EntityManager,
  tenantId: string,
  id: string,
  paidAmount: number,
): Promise<CustomerOrder> {
  const order = await findVisibleOrder(manager, tenantId, id, { lock: true });
  assertOrderActive(order);
  if (
    Math.round(Number(order.paidAmount) * 100) !== Math.round(paidAmount * 100)
  ) {
    throw new ConflictException(
      `The deposits of order ${order.orderNumber} changed: take the payment again`,
    );
  }
  return order;
}

/** The pickup sale completed (inside its transaction) */
export async function markOrderPickedUp(
  manager: EntityManager,
  audit: AuditService,
  order: CustomerOrder,
  sale: { id: string; saleNumber: string },
): Promise<void> {
  assertOrderTransition(order, CustomerOrderStatus.PICKED_UP);
  await manager.update(
    CustomerOrder,
    { id: order.id, tenantId: order.tenantId },
    {
      status: CustomerOrderStatus.PICKED_UP,
      saleId: sale.id,
      pickedUpAt: new Date(),
    },
  );
  await audit.record(
    {
      tenantId: order.tenantId,
      action: 'order.picked_up',
      entityType: 'customer_order',
      entityId: order.id,
      metadata: {
        orderNumber: order.orderNumber,
        saleId: sale.id,
        saleNumber: sale.saleNumber,
        depositsApplied: Number(order.paidAmount),
      },
    },
    manager,
  );
}

/**
 * A voided pickup sale gives the order back: ready again, its deposits intact
 * (the deposit tender of the voided sale is undone with it)
 */
export async function reopenOrderOfVoidedSale(
  manager: EntityManager,
  audit: AuditService,
  tenantId: string,
  sale: { id: string; saleNumber: string },
): Promise<void> {
  const order = await manager.findOne(CustomerOrder, {
    where: { tenantId, saleId: sale.id },
    lock: { mode: 'pessimistic_write' },
  });
  if (!order || order.status !== CustomerOrderStatus.PICKED_UP) return;
  await manager.update(
    CustomerOrder,
    { id: order.id, tenantId },
    { status: CustomerOrderStatus.READY, saleId: null, pickedUpAt: null },
  );
  await audit.record(
    {
      tenantId,
      action: 'order.pickup_voided',
      entityType: 'customer_order',
      entityId: order.id,
      metadata: {
        orderNumber: order.orderNumber,
        saleId: sale.id,
        saleNumber: sale.saleNumber,
      },
    },
    manager,
  );
}
