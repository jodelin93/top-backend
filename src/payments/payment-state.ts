import { PaymentStatus } from '../database/entities/payment.entity';

/**
 * Payment state machine (R051–R054).
 *
 *   initiated ──> pending ──> authorized ──> captured ──> refunded
 *       │            │            │
 *       └────────────┴────────────┴──> failed | cancelled | unknown
 *
 * `unknown` means the provider did not answer in time: the outcome is looked up
 * (by provider reference or idempotency key) before anything else happens.
 * `completed` is the one-step state of cash and manually confirmed card payments.
 */
const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  [PaymentStatus.INITIATED]: [
    PaymentStatus.PENDING,
    PaymentStatus.AUTHORIZED,
    PaymentStatus.CAPTURED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
    PaymentStatus.UNKNOWN,
  ],
  [PaymentStatus.PENDING]: [
    PaymentStatus.AUTHORIZED,
    PaymentStatus.CAPTURED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
    PaymentStatus.UNKNOWN,
  ],
  [PaymentStatus.AUTHORIZED]: [
    PaymentStatus.CAPTURED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
    PaymentStatus.UNKNOWN,
  ],
  [PaymentStatus.UNKNOWN]: [
    PaymentStatus.PENDING,
    PaymentStatus.AUTHORIZED,
    PaymentStatus.CAPTURED,
    PaymentStatus.FAILED,
    PaymentStatus.CANCELLED,
  ],
  [PaymentStatus.CAPTURED]: [PaymentStatus.REFUNDED],
  [PaymentStatus.COMPLETED]: [PaymentStatus.REFUNDED],
  [PaymentStatus.FAILED]: [],
  [PaymentStatus.CANCELLED]: [],
  [PaymentStatus.REFUNDED]: [],
};

// Money has been taken
export const SETTLED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.CAPTURED,
  PaymentStatus.COMPLETED,
];

// The attempt is over without money being taken (a new attempt may be started)
export const FAILED_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.FAILED,
  PaymentStatus.CANCELLED,
];

// Still waiting for the provider
export const OPEN_PAYMENT_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.INITIATED,
  PaymentStatus.PENDING,
  PaymentStatus.AUTHORIZED,
  PaymentStatus.UNKNOWN,
];

export function canTransitionPayment(
  from: PaymentStatus,
  to: PaymentStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Decide the status to store when a provider reports `reported` for a payment that is
 * currently `current`. Returns null when nothing should change: a repeated report
 * (webhook redelivery, lookup after a webhook) or an out-of-order one (e.g. "authorized"
 * arriving after "captured") must never move a payment backwards.
 */
export function nextPaymentStatus(
  current: PaymentStatus,
  reported: PaymentStatus,
): PaymentStatus | null {
  if (current === reported) return null;
  return canTransitionPayment(current, reported) ? reported : null;
}

/**
 * Overall state of a sale's payments
 */
export function summarizePayments(
  statuses: PaymentStatus[],
): 'settled' | 'failed' | 'open' {
  if (statuses.every((s) => SETTLED_PAYMENT_STATUSES.includes(s))) {
    return 'settled';
  }
  if (statuses.some((s) => FAILED_PAYMENT_STATUSES.includes(s))) {
    return 'failed';
  }
  return 'open';
}
