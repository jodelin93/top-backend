/**
 * Payment provider adapter contract (R051).
 *
 * Every card terminal / gateway integration implements this interface and is
 * registered in PaymentProviderRegistry under its `name`; payment methods choose
 * one with their `provider` field. Adapters talk to the provider only: they never
 * touch the database. PaymentsService owns state, idempotency and webhooks.
 *
 * Adding a provider (e.g. Stripe Terminal, Square): see docs/features/sales-pos-payments.md.
 */

// Status as reported by a provider, normalised
export type ProviderPaymentStatus =
  | 'pending'
  | 'authorized'
  | 'captured'
  | 'failed'
  | 'cancelled'
  | 'refunded'
  | 'unknown';

export interface ProviderResult {
  status: ProviderPaymentStatus;
  // The provider's id for the payment (intent / transaction id)
  providerReference?: string | null;
  failureReason?: string | null;
  // Raw provider response, kept in payment metadata for support
  raw?: Record<string, unknown>;
}

export interface InitiatePaymentRequest {
  tenantId: string;
  paymentId: string;
  saleId: string;
  amount: number;
  currencyCode: string;
  // Unique per attempt. Providers must treat a repeated key as the same payment,
  // which is what makes retries after a timeout safe.
  idempotencyKey: string;
  // Reference typed by the cashier, if any (terminal approval code)
  reference?: string | null;
}

export interface WebhookEvent {
  // Provider's unique event id (deduplication key)
  eventId: string;
  eventType: string;
  providerReference: string | null;
  // Our attempt key, when the provider echoes it back (metadata set at initiate).
  // Matches payments whose provider reference was never received (timeouts).
  idempotencyKey?: string | null;
  // Payment status the event reports, if it is about a payment
  status: ProviderPaymentStatus | null;
  // Amount the event reports, in minor units (cents); checked against the payment
  amount?: number | null;
  // ISO currency of that amount, when the provider sends it
  currencyCode?: string | null;
  payload: Record<string, unknown>;
}

export interface WebhookRequest {
  // Exact bytes received (signatures are computed over these)
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
  // Per-provider secret from the environment (PAYMENT_WEBHOOK_SECRET_<PROVIDER>)
  secret: string | null;
}

/** Thrown by adapters when the provider did not answer in time (outcome unknown) */
export class ProviderTimeoutError extends Error {
  constructor(message = 'The payment provider did not respond in time') {
    super(message);
    this.name = 'ProviderTimeoutError';
  }
}

/** Thrown by verifyWebhook when a webhook is not authentic */
export class InvalidWebhookError extends Error {
  constructor(message = 'Invalid webhook signature') {
    super(message);
    this.name = 'InvalidWebhookError';
  }
}

export interface PaymentProvider {
  readonly name: string;
  readonly label: string;
  /**
   * false: the payment is final as soon as the cashier records it (cash-like, e.g. the
   * manual card flow where the cashier types the terminal's approval code).
   * true: the payment is authorised asynchronously; the sale waits in payment_pending.
   */
  readonly async: boolean;

  initiate(request: InitiatePaymentRequest): Promise<ProviderResult>;
  capture(providerReference: string, amount: number): Promise<ProviderResult>;
  cancel(providerReference: string): Promise<ProviderResult>;
  refund(
    providerReference: string,
    amount: number,
    idempotencyKey: string,
  ): Promise<ProviderResult>;
  /** Current status, by provider reference or (after a timeout) by idempotency key */
  lookup(ref: {
    providerReference?: string | null;
    idempotencyKey: string;
  }): Promise<ProviderResult>;
  /** Verify the signature and parse the event; throws InvalidWebhookError */
  verifyWebhook(request: WebhookRequest): WebhookEvent;
}
