import { PaymentStatus as S } from '../database/entities/payment.entity';
import {
  canTransitionPayment,
  nextPaymentStatus,
  summarizePayments,
} from './payment-state';

describe('payment state machine', () => {
  it('follows initiated → pending → authorized → captured → refunded', () => {
    expect(canTransitionPayment(S.INITIATED, S.PENDING)).toBe(true);
    expect(canTransitionPayment(S.PENDING, S.AUTHORIZED)).toBe(true);
    expect(canTransitionPayment(S.AUTHORIZED, S.CAPTURED)).toBe(true);
    expect(canTransitionPayment(S.CAPTURED, S.REFUNDED)).toBe(true);
  });

  it('lets an unknown (timed out) payment resolve either way after a lookup', () => {
    expect(canTransitionPayment(S.UNKNOWN, S.CAPTURED)).toBe(true);
    expect(canTransitionPayment(S.UNKNOWN, S.FAILED)).toBe(true);
  });

  it('never moves a finished payment', () => {
    for (const to of Object.values(S)) {
      expect(canTransitionPayment(S.FAILED, to)).toBe(false);
      expect(canTransitionPayment(S.CANCELLED, to)).toBe(false);
      expect(canTransitionPayment(S.REFUNDED, to)).toBe(false);
    }
    expect(canTransitionPayment(S.CAPTURED, S.FAILED)).toBe(false);
  });

  it('ignores repeated and out-of-order reports', () => {
    expect(nextPaymentStatus(S.CAPTURED, S.CAPTURED)).toBeNull();
    // "authorized" webhook arriving after "captured"
    expect(nextPaymentStatus(S.CAPTURED, S.AUTHORIZED)).toBeNull();
    expect(nextPaymentStatus(S.AUTHORIZED, S.PENDING)).toBeNull();
    expect(nextPaymentStatus(S.PENDING, S.CAPTURED)).toBe(S.CAPTURED);
  });

  it('summarises a sale’s payments', () => {
    expect(summarizePayments([S.COMPLETED, S.CAPTURED])).toBe('settled');
    expect(summarizePayments([S.COMPLETED, S.PENDING])).toBe('open');
    expect(summarizePayments([S.CAPTURED, S.FAILED])).toBe('failed');
    expect(summarizePayments([S.UNKNOWN])).toBe('open');
  });
});
