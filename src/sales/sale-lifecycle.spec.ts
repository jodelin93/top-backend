import { ConflictException } from '@nestjs/common';
import { SaleStatus } from '../database/entities/sale.entity';
import { assertTransition, canTransition } from './sale-lifecycle';

describe('sale lifecycle', () => {
  it.each([
    [SaleStatus.DRAFT, SaleStatus.HELD],
    [SaleStatus.HELD, SaleStatus.DRAFT],
    [SaleStatus.HELD, SaleStatus.COMPLETED],
    [SaleStatus.DRAFT, SaleStatus.PAYMENT_PENDING],
    [SaleStatus.PAYMENT_PENDING, SaleStatus.COMPLETED],
    [SaleStatus.PAYMENT_PENDING, SaleStatus.CANCELLED],
    [SaleStatus.COMPLETED, SaleStatus.VOIDED],
    [SaleStatus.COMPLETED, SaleStatus.PARTIALLY_REFUNDED],
    [SaleStatus.PARTIALLY_REFUNDED, SaleStatus.REFUNDED],
  ])('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => assertTransition(from, to)).not.toThrow();
  });

  it.each([
    [SaleStatus.COMPLETED, SaleStatus.CANCELLED],
    [SaleStatus.COMPLETED, SaleStatus.HELD],
    [SaleStatus.VOIDED, SaleStatus.VOIDED],
    [SaleStatus.VOIDED, SaleStatus.COMPLETED],
    [SaleStatus.CANCELLED, SaleStatus.DRAFT],
    [SaleStatus.PAYMENT_PENDING, SaleStatus.HELD],
    [SaleStatus.PAYMENT_PENDING, SaleStatus.VOIDED],
    [SaleStatus.REFUNDED, SaleStatus.VOIDED],
  ])('rejects %s → %s with a 409', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => assertTransition(from, to)).toThrow(ConflictException);
  });

  it('explains the refused change', () => {
    expect(() =>
      assertTransition(SaleStatus.PAYMENT_PENDING, SaleStatus.VOIDED),
    ).toThrow('A payment pending sale cannot become voided');
  });
});
