import { ConflictException } from '@nestjs/common';
import { SaleStatus } from '../database/entities/sale.entity';

/**
 * The one place that decides which sale status changes are allowed (R046).
 *
 *   draft            cart being rung up (also a resumed held cart)
 *   held             parked cart, stock reserved until `heldUntil`
 *   payment_pending  waiting for card payments to be captured, stock reserved
 *   completed        paid; stock, discount usage and loyalty points applied
 *   cancelled        abandoned before completion (reservations released)
 *   voided / refunded / partially_refunded   after completion
 */
export const SALE_TRANSITIONS: Readonly<
  Record<SaleStatus, readonly SaleStatus[]>
> = {
  [SaleStatus.DRAFT]: [
    SaleStatus.HELD,
    SaleStatus.PAYMENT_PENDING,
    SaleStatus.COMPLETED,
    SaleStatus.CANCELLED,
  ],
  [SaleStatus.HELD]: [
    SaleStatus.HELD, // re-hold (edited cart or extended hold)
    SaleStatus.DRAFT, // resumed at a till
    SaleStatus.PAYMENT_PENDING,
    SaleStatus.COMPLETED,
    SaleStatus.CANCELLED,
  ],
  [SaleStatus.PAYMENT_PENDING]: [SaleStatus.COMPLETED, SaleStatus.CANCELLED],
  [SaleStatus.COMPLETED]: [
    SaleStatus.VOIDED,
    SaleStatus.PARTIALLY_REFUNDED,
    SaleStatus.REFUNDED,
  ],
  [SaleStatus.PARTIALLY_REFUNDED]: [
    SaleStatus.PARTIALLY_REFUNDED,
    SaleStatus.REFUNDED,
  ],
  [SaleStatus.CANCELLED]: [],
  [SaleStatus.VOIDED]: [],
  [SaleStatus.REFUNDED]: [],
};

// Carts that are not sales yet: they can be edited, held, resumed or cancelled
export const OPEN_CART_STATUSES: readonly SaleStatus[] = [
  SaleStatus.DRAFT,
  SaleStatus.HELD,
];

export function canTransition(from: SaleStatus, to: SaleStatus): boolean {
  return SALE_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Throws a 409 when a sale may not move from `from` to `to`
 */
export function assertTransition(from: SaleStatus, to: SaleStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictException(
      `A ${from.replace('_', ' ')} sale cannot become ${to.replace('_', ' ')}`,
    );
  }
}
