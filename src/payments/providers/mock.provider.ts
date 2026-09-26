import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import {
  InitiatePaymentRequest,
  InvalidWebhookError,
  PaymentProvider,
  ProviderPaymentStatus,
  ProviderResult,
  ProviderTimeoutError,
  WebhookEvent,
  WebhookRequest,
} from './payment-provider';

export const MOCK_SIGNATURE_HEADER = 'x-mock-signature';

export interface MockProviderOptions {
  // Time until a payment is captured (authorised at half of it)
  delayMs: number;
  // Signs the webhooks the mock sends to this server
  secret: string;
  // Whether to send webhooks at all (lookups work either way)
  sendWebhooks: boolean;
}

type Deliver = (request: {
  rawBody: string;
  headers: Record<string, string>;
}) => Promise<unknown>;

/**
 * Simulated card provider for development and tests (never in production).
 *
 * Behaviour by amount (cents):
 *   .13 → declined               .99 → the request times out (the charge still goes
 *   anything else → pending, authorised after delay/2, captured after delay
 *
 * Status is derived from the reference itself (it encodes the start time and amount),
 * so lookups keep working after a server restart; cancels/refunds are kept in memory.
 * Webhooks are signed with HMAC-SHA256 and delivered in-process through the same
 * verification path as real ones.
 */
export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly label = 'Mock card terminal (development only)';
  readonly async = true;

  private deliver: Deliver | null = null;
  private readonly overrides = new Map<string, ProviderPaymentStatus>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly keyByReference = new Map<string, string>();

  constructor(private readonly options: MockProviderOptions) {}

  static randomSecret(): string {
    return randomBytes(32).toString('hex');
  }

  onWebhook(deliver: Deliver) {
    this.deliver = deliver;
  }

  initiate(request: InitiatePaymentRequest): Promise<ProviderResult> {
    const existing = this.byIdempotencyKey.get(request.idempotencyKey);
    if (existing) {
      return Promise.resolve(this.result(existing));
    }
    const cents = Math.round(request.amount * 100);
    const reference = `mock_${Date.now()}_${cents}_${randomUUID().slice(0, 8)}`;
    this.byIdempotencyKey.set(request.idempotencyKey, reference);
    this.keyByReference.set(reference, request.idempotencyKey);

    if (cents % 100 === 99) {
      this.scheduleWebhooks(reference);
      return Promise.reject(new ProviderTimeoutError());
    }
    if (cents % 100 !== 13) {
      this.scheduleWebhooks(reference);
    }
    return Promise.resolve(this.result(reference));
  }

  capture(providerReference: string): Promise<ProviderResult> {
    const current = this.statusOf(providerReference);
    if (current === 'pending' || current === 'authorized') {
      this.overrides.set(providerReference, 'captured');
    }
    return Promise.resolve(this.result(providerReference));
  }

  cancel(providerReference: string): Promise<ProviderResult> {
    const current = this.statusOf(providerReference);
    if (current === 'pending' || current === 'authorized') {
      this.overrides.set(providerReference, 'cancelled');
    }
    return Promise.resolve(this.result(providerReference));
  }

  refund(providerReference: string): Promise<ProviderResult> {
    if (this.statusOf(providerReference) === 'captured') {
      this.overrides.set(providerReference, 'refunded');
    }
    return Promise.resolve(this.result(providerReference));
  }

  lookup(ref: {
    providerReference?: string | null;
    idempotencyKey: string;
  }): Promise<ProviderResult> {
    const reference =
      ref.providerReference ?? this.byIdempotencyKey.get(ref.idempotencyKey);
    if (!reference) {
      // The provider never saw this attempt: nothing was charged
      return Promise.resolve({
        status: 'failed',
        failureReason: 'The payment never reached the provider',
      });
    }
    return Promise.resolve(this.result(reference));
  }

  verifyWebhook(request: WebhookRequest): WebhookEvent {
    if (!request.secret) {
      throw new InvalidWebhookError('No webhook secret configured');
    }
    const header = request.headers[MOCK_SIGNATURE_HEADER];
    const signature = Array.isArray(header) ? header[0] : header;
    const expected = MockPaymentProvider.sign(request.rawBody, request.secret);
    if (
      !signature ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      throw new InvalidWebhookError();
    }
    let body: {
      id?: unknown;
      type?: unknown;
      data?: {
        reference?: unknown;
        status?: unknown;
        amount?: unknown;
        idempotencyKey?: unknown;
      };
    };
    try {
      body = JSON.parse(request.rawBody) as typeof body;
    } catch {
      throw new InvalidWebhookError('Webhook body is not JSON');
    }
    if (typeof body.id !== 'string' || typeof body.type !== 'string') {
      throw new InvalidWebhookError('Webhook event has no id or type');
    }
    const status = body.data?.status;
    return {
      eventId: body.id,
      eventType: body.type,
      providerReference:
        typeof body.data?.reference === 'string' ? body.data.reference : null,
      idempotencyKey:
        typeof body.data?.idempotencyKey === 'string'
          ? body.data.idempotencyKey
          : null,
      status: isStatus(status) ? status : null,
      amount: typeof body.data?.amount === 'number' ? body.data.amount : null,
      payload: body,
    };
  }

  static sign(rawBody: string, secret: string): string {
    return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  }

  /** Build a signed webhook as the mock "provider" would send it */
  buildWebhook(
    reference: string,
    status: ProviderPaymentStatus,
    eventId = `evt_${randomUUID()}`,
  ) {
    const rawBody = JSON.stringify({
      id: eventId,
      type: `payment.${status}`,
      data: {
        reference,
        status,
        amount: parse(reference)?.cents ?? null,
        idempotencyKey: this.keyByReference.get(reference) ?? null,
      },
    });
    return {
      rawBody,
      headers: {
        [MOCK_SIGNATURE_HEADER]: MockPaymentProvider.sign(
          rawBody,
          this.options.secret,
        ),
        'content-type': 'application/json',
      },
    };
  }

  // ---------------------------------------------------------------------------

  private statusOf(reference: string): ProviderPaymentStatus {
    const override = this.overrides.get(reference);
    if (override) return override;
    const parsed = parse(reference);
    if (!parsed) return 'unknown';
    if (parsed.cents % 100 === 13) return 'failed';
    const elapsed = Date.now() - parsed.startedAt;
    if (elapsed >= this.options.delayMs) return 'captured';
    if (elapsed >= this.options.delayMs / 2) return 'authorized';
    return 'pending';
  }

  private result(reference: string): ProviderResult {
    const status = this.statusOf(reference);
    return {
      status,
      providerReference: reference,
      failureReason: status === 'failed' ? 'Card declined' : null,
      raw: { reference, status },
    };
  }

  private scheduleWebhooks(reference: string) {
    if (!this.options.sendWebhooks) return;
    const send = (status: ProviderPaymentStatus) => {
      // Cancelled or refunded in the meantime: the provider would not report it
      if (this.statusOf(reference) !== status) return;
      void this.deliver?.(this.buildWebhook(reference, status)).catch(
        () => undefined,
      );
    };
    setTimeout(() => send('authorized'), this.options.delayMs / 2 + 10).unref();
    setTimeout(() => send('captured'), this.options.delayMs + 10).unref();
  }
}

function parse(reference: string): { startedAt: number; cents: number } | null {
  const match = /^mock_(\d+)_(\d+)_[0-9a-f]+$/.exec(reference);
  return match
    ? { startedAt: Number(match[1]), cents: Number(match[2]) }
    : null;
}

const STATUSES: ProviderPaymentStatus[] = [
  'pending',
  'authorized',
  'captured',
  'failed',
  'cancelled',
  'refunded',
  'unknown',
];
function isStatus(value: unknown): value is ProviderPaymentStatus {
  return STATUSES.includes(value as ProviderPaymentStatus);
}
