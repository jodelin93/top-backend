import { Module } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { ReconciliationService } from './reconciliation.service';
import { PaymentProviderRegistry } from './providers/provider-registry';
import {
  PaymentsController,
  PaymentWebhooksController,
} from './payments.controller';

/**
 * Card payments through provider adapters, webhooks and settlement reconciliation.
 * SalesModule imports this module (not the other way round) and registers the
 * handler that completes a sale once its payments are captured.
 */
@Module({
  controllers: [PaymentsController, PaymentWebhooksController],
  providers: [PaymentsService, ReconciliationService, PaymentProviderRegistry],
  exports: [PaymentsService, PaymentProviderRegistry],
})
export class PaymentsModule {}
