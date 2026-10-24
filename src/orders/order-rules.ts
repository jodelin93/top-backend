import { ConflictException } from '@nestjs/common';
import { CustomerOrderStatus } from '../database/entities/customer-order.entity';

/**
 * Order rules, kept free of the database so they are easy to test.
 *
 *   open       taken, being prepared (deposits can be added)
 *   ready      prepared, waiting for the customer (deposits can be added)
 *   picked_up  sold by its pickup sale; a void of that sale makes it ready again
 *   cancelled  its deposits refunded or kept (a manager decides)
 */
export const ORDER_TRANSITIONS: Readonly<
  Record<CustomerOrderStatus, readonly CustomerOrderStatus[]>
> = {
  [CustomerOrderStatus.OPEN]: [
    CustomerOrderStatus.READY,
    CustomerOrderStatus.PICKED_UP,
    CustomerOrderStatus.CANCELLED,
  ],
  [CustomerOrderStatus.READY]: [
    CustomerOrderStatus.OPEN,
    CustomerOrderStatus.PICKED_UP,
    CustomerOrderStatus.CANCELLED,
  ],
  [CustomerOrderStatus.PICKED_UP]: [CustomerOrderStatus.READY],
  [CustomerOrderStatus.CANCELLED]: [],
};

// Orders still waiting for their customer: deposits, pickup, cancellation
export const ACTIVE_ORDER_STATUSES: readonly CustomerOrderStatus[] = [
  CustomerOrderStatus.OPEN,
  CustomerOrderStatus.READY,
];

const LABELS: Record<CustomerOrderStatus, string> = {
  [CustomerOrderStatus.OPEN]: 'in preparation',
  [CustomerOrderStatus.READY]: 'ready',
  [CustomerOrderStatus.PICKED_UP]: 'picked up',
  [CustomerOrderStatus.CANCELLED]: 'cancelled',
};

export const orderStatusLabel = (status: CustomerOrderStatus) =>
  LABELS[status] ?? status;

export function canMoveOrder(
  from: CustomerOrderStatus,
  to: CustomerOrderStatus,
): boolean {
  return ORDER_TRANSITIONS[from]?.includes(to) ?? false;
}

/** 409 when the order can't move from `from` to `to` */
export function assertOrderTransition(
  order: { orderNumber: string; status: CustomerOrderStatus },
  to: CustomerOrderStatus,
): void {
  if (!canMoveOrder(order.status, to)) {
    throw new ConflictException(
      `Order ${order.orderNumber} is ${orderStatusLabel(order.status)}`,
    );
  }
}

/** 409 unless the order still waits for its customer */
export function assertOrderActive(order: {
  orderNumber: string;
  status: CustomerOrderStatus;
}): void {
  if (!ACTIVE_ORDER_STATUSES.includes(order.status)) {
    throw new ConflictException(
      `Order ${order.orderNumber} is ${orderStatusLabel(order.status)}`,
    );
  }
}

const cents = (value: number | string) => Math.round(Number(value) * 100);

/** What the customer still owes on the order */
export const balanceDue = (order: {
  total: number | string;
  paidAmount: number | string;
}) => Math.max(0, cents(order.total) - cents(order.paidAmount)) / 100;

/**
 * A new deposit must be positive and leave nothing overpaid: the deposits
 * never add up to more than the order. Returns the error, or null.
 */
export function depositError(
  order: { total: number | string; paidAmount: number | string },
  amount: number,
): string | null {
  if (!(cents(amount) > 0)) return 'The deposit must be more than 0.00';
  const due = balanceDue(order);
  if (cents(amount) > cents(due)) {
    return due > 0
      ? `The deposit can't be more than the balance due (${due.toFixed(2)})`
      : 'This order is already paid in full: the customer pays nothing more at pickup';
  }
  return null;
}
