import { ConflictException } from '@nestjs/common';
import { CustomerOrderStatus } from '../database/entities/customer-order.entity';
import {
  assertOrderActive,
  assertOrderTransition,
  balanceDue,
  canMoveOrder,
  depositError,
} from './order-rules';

const order = (status: CustomerOrderStatus) => ({
  orderNumber: 'MAIN-CMD-000001',
  status,
});

describe('order rules', () => {
  it('moves an order through preparation, ready and pickup', () => {
    expect(
      canMoveOrder(CustomerOrderStatus.OPEN, CustomerOrderStatus.READY),
    ).toBe(true);
    expect(
      canMoveOrder(CustomerOrderStatus.READY, CustomerOrderStatus.OPEN),
    ).toBe(true);
    expect(
      canMoveOrder(CustomerOrderStatus.READY, CustomerOrderStatus.PICKED_UP),
    ).toBe(true);
    // A voided pickup sale gives the order back
    expect(
      canMoveOrder(CustomerOrderStatus.PICKED_UP, CustomerOrderStatus.READY),
    ).toBe(true);
    expect(
      canMoveOrder(
        CustomerOrderStatus.PICKED_UP,
        CustomerOrderStatus.CANCELLED,
      ),
    ).toBe(false);
    expect(
      canMoveOrder(CustomerOrderStatus.CANCELLED, CustomerOrderStatus.OPEN),
    ).toBe(false);
  });

  it('refuses work on an order no longer waiting for its customer', () => {
    expect(() =>
      assertOrderActive(order(CustomerOrderStatus.READY)),
    ).not.toThrow();
    expect(() =>
      assertOrderActive(order(CustomerOrderStatus.PICKED_UP)),
    ).toThrow(new ConflictException('Order MAIN-CMD-000001 is picked up'));
    expect(() =>
      assertOrderTransition(
        order(CustomerOrderStatus.CANCELLED),
        CustomerOrderStatus.READY,
      ),
    ).toThrow('Order MAIN-CMD-000001 is cancelled');
  });

  it('computes the balance due in cents', () => {
    expect(balanceDue({ total: '10000.0000', paidAmount: '4000.10' })).toBe(
      5999.9,
    );
    expect(balanceDue({ total: 100, paidAmount: 100 })).toBe(0);
  });

  it('accepts any positive deposit up to the balance', () => {
    const o = { total: 1000, paidAmount: 400 };
    expect(depositError(o, 600)).toBeNull();
    expect(depositError(o, 0.01)).toBeNull();
    expect(depositError(o, 0)).toMatch(/more than 0.00/);
    expect(depositError(o, 600.01)).toMatch(/balance due \(600.00\)/);
    expect(depositError({ total: 1000, paidAmount: 1000 }, 1)).toMatch(
      /paid in full/,
    );
  });
});
