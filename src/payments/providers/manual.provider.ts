import {
  InitiatePaymentRequest,
  InvalidWebhookError,
  PaymentProvider,
  ProviderResult,
  WebhookEvent,
} from './payment-provider';

/**
 * The card terminal is not integrated: the cashier runs the card on a standalone
 * terminal and types its approval code. The payment is final when recorded, and
 * refunds are done on the terminal (this adapter just records them).
 */
export class ManualPaymentProvider implements PaymentProvider {
  readonly name = 'manual';
  readonly label = 'Manual (cashier confirms the terminal approval)';
  readonly async = false;

  initiate(request: InitiatePaymentRequest): Promise<ProviderResult> {
    return Promise.resolve({
      status: 'captured',
      // Terminal approval codes are not unique across terminals: keep them in
      // payments.reference, not as the provider reference
      providerReference: null,
      raw: { approvalCode: request.reference ?? null },
    });
  }

  capture(): Promise<ProviderResult> {
    return Promise.resolve({ status: 'captured' });
  }

  cancel(): Promise<ProviderResult> {
    return Promise.resolve({ status: 'cancelled' });
  }

  refund(): Promise<ProviderResult> {
    // Done by the cashier on the terminal
    return Promise.resolve({ status: 'refunded' });
  }

  lookup(): Promise<ProviderResult> {
    return Promise.resolve({ status: 'captured' });
  }

  verifyWebhook(): WebhookEvent {
    throw new InvalidWebhookError('The manual provider does not send webhooks');
  }
}
