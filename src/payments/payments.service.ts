import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { canAccessBranch, hasAllBranches } from '../auth/branch-scope';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager, In } from 'typeorm';
import { randomUUID } from 'crypto';
import { Payment, PaymentStatus } from '../database/entities/payment.entity';
import {
  PaymentMethod,
  PaymentMethodType,
} from '../database/entities/payment-method.entity';
import { Sale, SaleStatus } from '../database/entities/sale.entity';
import { PaymentWebhookEvent } from '../database/entities/payment-webhook-event.entity';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../platform/outbox/outbox.service';
import {
  nextPaymentStatus,
  OPEN_PAYMENT_STATUSES,
  summarizePayments,
} from './payment-state';
import {
  InvalidWebhookError,
  PaymentProvider,
  ProviderPaymentStatus,
  ProviderResult,
  ProviderTimeoutError,
  WebhookEvent,
} from './providers/payment-provider';
import { PaymentProviderRegistry } from './providers/provider-registry';
import { MockPaymentProvider } from './providers/mock.provider';

const STATUS_MAP: Record<ProviderPaymentStatus, PaymentStatus> = {
  pending: PaymentStatus.PENDING,
  authorized: PaymentStatus.AUTHORIZED,
  captured: PaymentStatus.CAPTURED,
  failed: PaymentStatus.FAILED,
  cancelled: PaymentStatus.CANCELLED,
  refunded: PaymentStatus.REFUNDED,
  unknown: PaymentStatus.UNKNOWN,
};

// Statuses worth an audit entry
const AUDITED = new Set<PaymentStatus>([
  PaymentStatus.CAPTURED,
  PaymentStatus.FAILED,
  PaymentStatus.CANCELLED,
  PaymentStatus.UNKNOWN,
  PaymentStatus.REFUNDED,
]);

// A pending payment older than this is looked up at the provider when the POS polls
/**
 * Why a webhook's money does not match its payment (null: it does, or the event
 * carries no amount). Only events that report money taken are checked. Amounts
 * are in minor units (cents), as providers send them.
 */
export function webhookMismatch(
  payment: Pick<Payment, 'amount' | 'currencyCode'>,
  event: Pick<WebhookEvent, 'status' | 'amount' | 'currencyCode'>,
): string | null {
  if (event.status !== 'authorized' && event.status !== 'captured') {
    return null;
  }
  const expected = Math.round(Number(payment.amount) * 100);
  if (event.amount != null && Math.round(event.amount) !== expected) {
    return `Amount ${event.amount} does not match the payment (${expected})`;
  }
  if (
    event.currencyCode &&
    payment.currencyCode &&
    event.currencyCode.toUpperCase() !== payment.currencyCode.toUpperCase()
  ) {
    return `Currency ${event.currencyCode} does not match the payment (${payment.currencyCode})`;
  }
  return null;
}

const STALE_AFTER_MS = 10_000;
const LOOKUP_INTERVAL_MS = 5_000;

export type SaleSettledHandler = (
  tenantId: string,
  saleId: string,
) => Promise<void>;

export interface SalePaymentState {
  saleId: string;
  saleNumber: string;
  saleStatus: SaleStatus;
  // settled: every payment captured; failed: at least one attempt failed (retry or cancel)
  state: 'settled' | 'failed' | 'open';
  payments: {
    id: string;
    amount: number;
    status: PaymentStatus;
    provider: string | null;
    providerReference: string | null;
    failureReason: string | null;
    methodName: string | null;
  }[];
}

/**
 * Card payments through provider adapters (R051–R054): payment attempts, the payment
 * state machine, lookups after timeouts, webhooks and cancellation/refunds.
 * Sales own the sale lifecycle: when every payment of a payment_pending sale is
 * captured, the registered "settled" handler (SalesService) completes the sale.
 */
@Injectable()
export class PaymentsService implements OnModuleInit {
  private readonly logger = new Logger(PaymentsService.name);
  private settledHandler: SaleSettledHandler | null = null;

  constructor(
    private dataSource: DataSource,
    private registry: PaymentProviderRegistry,
    private auditService: AuditService,
    private configService: ConfigService,
    @Optional() private outbox?: OutboxService,
  ) {}

  onModuleInit() {
    // The mock provider "sends" its webhooks through the real verification path
    if (this.registry.has('mock')) {
      const mock = this.registry.get('mock') as MockPaymentProvider;
      mock.onWebhook(({ rawBody, headers }) =>
        this.handleWebhook('mock', rawBody, headers).catch((error: Error) =>
          this.logger.warn(`Mock webhook failed: ${error.message}`),
        ),
      );
    }
  }

  onSaleSettled(handler: SaleSettledHandler) {
    this.settledHandler = handler;
  }

  providers() {
    return this.registry.list();
  }

  /** The provider adapter a payment method uses ('manual' when unset or unknown) */
  providerOf(method: Pick<PaymentMethod, 'provider'>): PaymentProvider {
    const name = method.provider || 'manual';
    return this.registry.has(name)
      ? this.registry.get(name)
      : this.registry.get('manual');
  }

  async setMethodProvider(
    tenantId: string,
    methodId: string,
    provider: string,
  ) {
    this.registry.get(provider); // 400 for unknown providers
    const repo = this.dataSource.getRepository(PaymentMethod);
    const method = await repo.findOne({ where: { id: methodId, tenantId } });
    if (!method) throw new NotFoundException('Payment method not found');
    if (method.methodType === PaymentMethodType.CASH && provider !== 'manual') {
      throw new BadRequestException('Cash cannot use a card provider');
    }
    const before = method.provider;
    await repo.update({ id: methodId, tenantId }, { provider });
    await this.auditService.record({
      tenantId,
      action: 'payment_method.provider_changed',
      entityType: 'payment_method',
      entityId: methodId,
      changes: { before: { provider: before }, after: { provider } },
    });
    return repo.findOneOrFail({ where: { id: methodId, tenantId } });
  }

  // ---------------------------------------------------------------------------
  // Attempts

  /**
   * Send every not-yet-started provider payment of a sale to its provider
   * (called after the payment_pending sale is committed)
   */
  async startPayments(tenantId: string, saleId: string): Promise<void> {
    const payments = await this.dataSource.getRepository(Payment).find({
      where: { tenantId, saleId, status: PaymentStatus.INITIATED },
      relations: { paymentMethod: true },
    });
    for (const payment of payments) {
      await this.initiate(payment);
    }
    await this.evaluateSale(tenantId, saleId);
  }

  /**
   * Current payment state of a sale. Payments stuck in pending/unknown are looked up
   * at the provider first (the lookup-on-timeout path).
   */
  async saleState(tenantId: string, saleId: string): Promise<SalePaymentState> {
    const sale = await this.dataSource
      .getRepository(Sale)
      .findOne({ where: { id: saleId, tenantId } });
    // Another branch's sale is "not found" (spec §9)
    if (!sale || !canAccessBranch(sale.branchId)) {
      throw new NotFoundException('Sale not found');
    }

    if (sale.status === SaleStatus.PAYMENT_PENDING) {
      const now = Date.now();
      const open = await this.dataSource.getRepository(Payment).find({
        where: { tenantId, saleId, status: In([...OPEN_PAYMENT_STATUSES]) },
      });
      let changed = false;
      for (const payment of open) {
        const stale =
          payment.status === PaymentStatus.UNKNOWN ||
          now - new Date(payment.createdAt).getTime() > STALE_AFTER_MS;
        const recentlyChecked =
          payment.lastCheckedAt &&
          now - new Date(payment.lastCheckedAt).getTime() < LOOKUP_INTERVAL_MS;
        if (payment.provider && stale && !recentlyChecked) {
          changed = (await this.lookupPayment(payment)) || changed;
        }
      }
      // Also retries a completion that failed earlier (idempotent, row-locked)
      if (changed || open.length === 0) {
        await this.evaluateSale(tenantId, saleId);
      }
    }
    return this.describe(tenantId, saleId);
  }

  /** Ask the provider for the payment's current status */
  async lookup(tenantId: string, paymentId: string): Promise<SalePaymentState> {
    const payment = await this.findPayment(tenantId, paymentId);
    if (!payment.provider) {
      throw new BadRequestException('This payment has no provider to ask');
    }
    await this.lookupPayment(payment);
    await this.evaluateSale(tenantId, payment.saleId);
    return this.describe(tenantId, payment.saleId);
  }

  /**
   * New attempt for a failed or cancelled payment of a sale still waiting for payment.
   * The new attempt gets its own idempotency key.
   */
  async retry(tenantId: string, paymentId: string): Promise<SalePaymentState> {
    const payment = await this.findPayment(tenantId, paymentId);
    const sale = await this.dataSource
      .getRepository(Sale)
      .findOneOrFail({ where: { id: payment.saleId, tenantId } });
    if (sale.status !== SaleStatus.PAYMENT_PENDING) {
      throw new ConflictException('This sale is not waiting for payment');
    }
    if (
      payment.status !== PaymentStatus.FAILED &&
      payment.status !== PaymentStatus.CANCELLED
    ) {
      throw new ConflictException(
        `Only failed payments can be retried (this one is ${payment.status})`,
      );
    }
    const previous = (payment.metadata?.attempts ?? []) as Record<
      string,
      string | null
    >[];
    const attempts: Record<string, string | null>[] = [
      ...previous,
      {
        idempotencyKey: payment.idempotencyKey,
        providerReference: payment.providerReference,
        status: payment.status,
        failureReason: payment.failureReason,
      },
    ];
    await this.dataSource.getRepository(Payment).update(
      { id: payment.id, tenantId },
      {
        status: PaymentStatus.INITIATED,
        idempotencyKey: `${sale.id}:${payment.id}:${attempts.length + 1}`,
        providerReference: null,
        failureReason: null,
        authorizedAt: null,
        capturedAt: null,
        metadata: { ...payment.metadata, attempts },
      },
    );
    await this.startPayments(tenantId, sale.id);
    return this.describe(tenantId, sale.id);
  }

  /**
   * Stop collecting money for a sale that is being cancelled: open attempts are
   * cancelled at the provider, captured ones refunded. Returns false if a payment
   * could not be cancelled or refunded (the sale must not be cancelled then).
   */
  async cancelSalePayments(tenantId: string, saleId: string): Promise<boolean> {
    const payments = await this.dataSource.getRepository(Payment).find({
      where: { tenantId, saleId },
    });
    let ok = true;
    for (const payment of payments) {
      if (!payment.provider) continue;
      const provider = this.registry.has(payment.provider)
        ? this.registry.get(payment.provider)
        : null;
      if (!provider || !provider.async) continue;
      try {
        if (OPEN_PAYMENT_STATUSES.includes(payment.status)) {
          // Find out what really happened first (a timed-out attempt may have been charged)
          await this.lookupPayment(payment);
          const current = await this.findPayment(tenantId, payment.id);
          if (OPEN_PAYMENT_STATUSES.includes(current.status)) {
            const result = current.providerReference
              ? await provider.cancel(current.providerReference)
              : ({ status: 'cancelled' } as ProviderResult);
            await this.apply(current, result, 'cancel');
          }
        }
        const latest = await this.findPayment(tenantId, payment.id);
        if (latest.status === PaymentStatus.CAPTURED) {
          const result = await provider.refund(
            latest.providerReference ?? '',
            Number(latest.amount),
            `${latest.idempotencyKey}:refund`,
          );
          await this.apply(latest, result, 'refund');
        }
        const final = await this.findPayment(tenantId, payment.id);
        if (
          OPEN_PAYMENT_STATUSES.includes(final.status) ||
          final.status === PaymentStatus.CAPTURED
        ) {
          ok = false;
        }
      } catch (error) {
        this.logger.warn(
          `Could not cancel payment ${payment.id}: ${(error as Error).message}`,
        );
        ok = false;
      }
    }
    return ok;
  }

  // ---------------------------------------------------------------------------
  // Webhooks

  async handleWebhook(
    providerName: string,
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): Promise<{ received: true; duplicate?: boolean; matched?: boolean }> {
    if (!this.registry.has(providerName)) {
      throw new NotFoundException('Unknown payment provider');
    }
    const provider = this.registry.get(providerName);
    let event;
    try {
      event = provider.verifyWebhook({
        rawBody,
        headers,
        secret: this.registry.webhookSecret(providerName),
      });
    } catch (error) {
      if (error instanceof InvalidWebhookError) {
        throw new UnauthorizedException(error.message);
      }
      throw error;
    }

    // Deduplicate by provider event id: redeliveries are acknowledged and ignored
    const inserted = await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(PaymentWebhookEvent)
      .values({
        provider: providerName,
        eventId: event.eventId,
        eventType: event.eventType,
        providerReference: event.providerReference,
        payload: event.payload as Record<string, any>,
      })
      .orIgnore()
      .returning(['id'])
      .execute();
    const eventRowId = (inserted.raw as { id: string }[])[0]?.id;
    if (!eventRowId) {
      return { received: true, duplicate: true };
    }

    const events = this.dataSource.getRepository(PaymentWebhookEvent);
    const payment = await this.findWebhookPayment(providerName, event);
    if (!payment || !event.status) {
      await events.update(eventRowId, {
        processedAt: new Date(),
        error: payment ? null : 'No payment with this reference',
      });
      return { received: true, matched: false };
    }

    // A webhook for another amount or currency than the payment is never
    // applied: kept on the payment for someone to look at
    const mismatch = webhookMismatch(payment, event);
    if (mismatch) {
      const metadata: Payment['metadata'] = {
        ...payment.metadata,
        needsReview: true,
        webhookMismatch: {
          eventId: event.eventId,
          status: event.status,
          reason: mismatch,
        },
      };
      await this.dataSource
        .getRepository(Payment)
        .update({ id: payment.id, tenantId: payment.tenantId }, { metadata });
      await this.auditService.record({
        tenantId: payment.tenantId,
        action: 'payment.webhook_mismatch',
        entityType: 'payment',
        entityId: payment.id,
        reason: mismatch,
        metadata: {
          saleId: payment.saleId,
          provider: providerName,
          eventId: event.eventId,
          status: event.status,
        },
      });
      await events.update(eventRowId, {
        tenantId: payment.tenantId,
        processedAt: new Date(),
        error: mismatch,
      });
      return { received: true, matched: false };
    }

    try {
      const changed = await this.apply(
        payment,
        { status: event.status, providerReference: event.providerReference },
        `webhook ${event.eventType}`,
      );
      await events.update(eventRowId, {
        tenantId: payment.tenantId,
        processedAt: new Date(),
      });
      if (changed) await this.evaluateSale(payment.tenantId, payment.saleId);
    } catch (error) {
      await events.update(eventRowId, {
        tenantId: payment.tenantId,
        error: (error as Error).message.slice(0, 500),
      });
      throw error;
    }
    return { received: true, matched: true };
  }

  /**
   * The payment a webhook is about: by provider reference, else by our attempt key
   * (a payment whose initiate call timed out has no provider reference yet)
   */
  private async findWebhookPayment(
    provider: string,
    event: WebhookEvent,
  ): Promise<Payment | null> {
    const repo = this.dataSource.getRepository(Payment);
    if (event.providerReference) {
      const byReference = await repo.findOne({
        where: { provider, providerReference: event.providerReference },
      });
      if (byReference) return byReference;
    }
    if (event.idempotencyKey) {
      // Keys are unique per store only: never guess between stores
      const byKey = await repo.find({
        where: { provider, idempotencyKey: event.idempotencyKey },
        take: 2,
      });
      if (byKey.length === 1) return byKey[0];
    }
    return null;
  }

  // ---------------------------------------------------------------------------

  private async initiate(payment: Payment): Promise<void> {
    const provider = this.providerOf(payment.paymentMethod);
    let result: ProviderResult;
    try {
      result = await this.withTimeout(
        provider.initiate({
          tenantId: payment.tenantId,
          paymentId: payment.id,
          saleId: payment.saleId,
          amount: Number(payment.amount),
          currencyCode: payment.currencyCode,
          idempotencyKey: payment.idempotencyKey,
          reference: payment.reference,
        }),
      );
    } catch (error) {
      // No answer: the charge may or may not have happened. Look it up later.
      result = {
        status: 'unknown',
        failureReason:
          error instanceof ProviderTimeoutError
            ? error.message
            : `Provider error: ${(error as Error).message}`,
      };
    }
    await this.apply(payment, result, 'initiate');
  }

  private async lookupPayment(payment: Payment): Promise<boolean> {
    const provider = this.registry.has(payment.provider ?? '')
      ? this.registry.get(payment.provider!)
      : null;
    if (!provider) return false;
    try {
      const result = await this.withTimeout(
        provider.lookup({
          providerReference: payment.providerReference,
          idempotencyKey: payment.idempotencyKey,
        }),
      );
      return await this.apply(payment, result, 'lookup');
    } catch (error) {
      await this.dataSource
        .getRepository(Payment)
        .update({ id: payment.id }, { lastCheckedAt: new Date() });
      this.logger.warn(
        `Lookup of payment ${payment.id} failed: ${(error as Error).message}`,
      );
      return false;
    }
  }

  /**
   * Apply a provider result to a payment (row-locked). Returns true if the status changed.
   */
  private apply(
    payment: Payment,
    result: ProviderResult,
    source: string,
  ): Promise<boolean> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const current = await manager.findOne(Payment, {
        where: { id: payment.id, tenantId: payment.tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!current) return false;

      const next = nextPaymentStatus(current.status, STATUS_MAP[result.status]);
      const now = new Date();
      const patch: Partial<Payment> = {
        lastCheckedAt: now,
        metadata: {
          ...current.metadata,
          lastProviderStatus: result.status,
          lastProviderSource: source,
        },
      };
      if (result.providerReference && !current.providerReference) {
        patch.providerReference = result.providerReference;
      }
      if (next) {
        patch.status = next;
        if (next === PaymentStatus.AUTHORIZED) patch.authorizedAt = now;
        if (next === PaymentStatus.CAPTURED) {
          patch.capturedAt = now;
          patch.authorizedAt = current.authorizedAt ?? now;
          patch.failureReason = null;
        }
        if (
          next === PaymentStatus.FAILED ||
          next === PaymentStatus.UNKNOWN ||
          next === PaymentStatus.CANCELLED
        ) {
          patch.failureReason = result.failureReason?.slice(0, 255) ?? null;
        }
      }
      await manager.update(Payment, { id: current.id }, patch);

      if (next && AUDITED.has(next)) {
        await this.auditService.record(
          {
            tenantId: current.tenantId,
            action: `payment.${next}`,
            entityType: 'payment',
            entityId: current.id,
            // Webhooks and background lookups have no signed-in user (actor null)
            reason: patch.failureReason ?? null,
            metadata: {
              saleId: current.saleId,
              amount: current.amount,
              provider: current.provider,
              providerReference:
                patch.providerReference ?? current.providerReference,
              from: current.status,
              source,
            },
          },
          manager,
        );
      }
      if (next === PaymentStatus.CAPTURED) {
        await this.outbox?.record(manager, {
          tenantId: current.tenantId,
          type: 'payment.captured',
          aggregateId: current.id,
          payload: {
            paymentId: current.id,
            saleId: current.saleId,
            amount: Number(current.amount),
            currencyCode: current.currencyCode,
            provider: current.provider ?? null,
          },
        });
      }
      return !!next;
    });
  }

  /** Completes the sale through the registered handler once every payment is captured */
  private async evaluateSale(tenantId: string, saleId: string) {
    const payments = await this.dataSource
      .getRepository(Payment)
      .find({ where: { tenantId, saleId } });
    if (
      payments.length > 0 &&
      summarizePayments(payments.map((p) => p.status)) === 'settled'
    ) {
      await this.settledHandler?.(tenantId, saleId);
    }
  }

  private async describe(
    tenantId: string,
    saleId: string,
  ): Promise<SalePaymentState> {
    const sale = await this.dataSource
      .getRepository(Sale)
      .findOneOrFail({ where: { id: saleId, tenantId } });
    const payments = await this.dataSource.getRepository(Payment).find({
      where: { tenantId, saleId },
      relations: { paymentMethod: true },
      order: { createdAt: 'ASC' },
    });
    return {
      saleId,
      saleNumber: sale.saleNumber,
      saleStatus: sale.status,
      state: summarizePayments(payments.map((p) => p.status)),
      payments: payments.map((p) => ({
        id: p.id,
        amount: Number(p.amount),
        status: p.status,
        provider: p.provider,
        providerReference: p.providerReference,
        failureReason: p.failureReason,
        methodName: p.paymentMethod?.name?.en ?? p.paymentMethod?.code ?? null,
      })),
    };
  }

  private async findPayment(tenantId: string, id: string): Promise<Payment> {
    const payment = await this.dataSource
      .getRepository(Payment)
      .findOne({ where: { id, tenantId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (!hasAllBranches() && payment.saleId) {
      const sale = await this.dataSource.getRepository(Sale).findOne({
        where: { id: payment.saleId, tenantId },
        select: { id: true, branchId: true },
      });
      if (!canAccessBranch(sale?.branchId)) {
        throw new NotFoundException('Payment not found');
      }
    }
    return payment;
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    const ms = Number(
      this.configService.get<string>('PAYMENT_PROVIDER_TIMEOUT_MS') ?? 15000,
    );
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProviderTimeoutError()), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /** Idempotency key for a new payment attempt */
  static attemptKey(saleKey: string | null | undefined, index: number): string {
    return saleKey ? `${saleKey}:p${index + 1}` : randomUUID();
  }
}
