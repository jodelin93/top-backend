import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Payment, PaymentStatus } from '../database/entities/payment.entity';
import { PaymentWebhookEvent } from '../database/entities/payment-webhook-event.entity';
import { AuditService } from '../audit/audit.service';
import { PaymentsService, webhookMismatch } from './payments.service';
import { OutboxService } from '../platform/outbox/outbox.service';
import { PaymentProviderRegistry } from './providers/provider-registry';
import { MockPaymentProvider } from './providers/mock.provider';

const SECRET = 'whsec-test';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let mock: MockPaymentProvider;
  let payments: Payment[];
  let insertedIds: string[];

  const eventsRepo = { update: jest.fn() };
  const paymentsRepo = {
    findOne: jest.fn(({ where }: { where: Partial<Payment> }) =>
      Promise.resolve(
        payments.find(
          (p) =>
            (where.id === undefined || p.id === where.id) &&
            (where.providerReference === undefined ||
              p.providerReference === where.providerReference),
        ) ?? null,
      ),
    ),
    find: jest.fn(() => Promise.resolve(payments)),
    update: jest.fn(),
    // Sale lookups (describe)
    findOneOrFail: jest.fn(() =>
      Promise.resolve({
        id: 'sale-2',
        saleNumber: 'P-000001',
        status: 'payment_pending',
      }),
    ),
  };
  const manager = {
    findOne: jest.fn((_e: unknown, { where }: { where: { id: string } }) =>
      Promise.resolve(payments.find((p) => p.id === where.id) ?? null),
    ),
    update: jest.fn(
      (_e: unknown, where: { id: string }, patch: Partial<Payment>) => {
        Object.assign(
          payments.find((p) => p.id === where.id)!,
          patch,
        );
        return Promise.resolve({ affected: 1 });
      },
    ),
  };
  const insertChain = {
    insert: () => insertChain,
    into: () => insertChain,
    values: () => insertChain,
    orIgnore: () => insertChain,
    returning: () => insertChain,
    execute: jest.fn(() =>
      Promise.resolve({
        raw: insertedIds.length ? [{ id: insertedIds.shift() }] : [],
      }),
    ),
  };
  const dataSource = {
    getRepository: jest.fn((entity: unknown) =>
      entity === PaymentWebhookEvent ? eventsRepo : paymentsRepo,
    ),
    createQueryBuilder: jest.fn(() => insertChain),
    transaction: jest.fn((work: (m: typeof manager) => Promise<unknown>) =>
      work(manager),
    ),
  };
  const audit = { record: jest.fn() };
  const outbox = { record: jest.fn() };
  const settled = jest.fn(() => Promise.resolve());

  beforeEach(() => {
    jest.clearAllMocks();
    const config = {
      get: (key: string) =>
        ({
          NODE_ENV: 'test',
          PAYMENT_WEBHOOK_SECRET_MOCK: SECRET,
          PAYMENT_MOCK_WEBHOOKS: 'false',
          PAYMENT_MOCK_DELAY_MS: '1000',
        })[key],
    } as unknown as ConfigService;
    const registry = new PaymentProviderRegistry(config);
    mock = registry.get('mock') as MockPaymentProvider;
    service = new PaymentsService(
      dataSource as unknown as DataSource,
      registry,
      audit as unknown as AuditService,
      config,
      outbox as unknown as OutboxService,
    );
    service.onSaleSettled(settled);
    payments = [
      {
        id: 'pay-1',
        tenantId: 't1',
        saleId: 'sale-1',
        amount: 20,
        status: PaymentStatus.PENDING,
        provider: 'mock',
        providerReference: 'mock_1_2000_abcdef01',
        metadata: {},
      } as unknown as Payment,
    ];
    insertedIds = ['evt-row-1'];
  });

  it('lists the manual and mock providers', () => {
    expect(service.providers().map((p) => p.name)).toEqual(['manual', 'mock']);
  });

  it('rejects webhooks for unknown providers and bad signatures', async () => {
    await expect(service.handleWebhook('stripe', '{}', {})).rejects.toThrow(
      NotFoundException,
    );
    const { rawBody } = mock.buildWebhook('mock_1_2000_abcdef01', 'captured');
    await expect(
      service.handleWebhook('mock', rawBody, {
        'x-mock-signature': 'sha256=bad',
      }),
    ).rejects.toThrow(UnauthorizedException);
    expect(insertChain.execute).not.toHaveBeenCalled();
  });

  it('captures the payment and completes the sale once everything is captured', async () => {
    const { rawBody, headers } = mock.buildWebhook(
      'mock_1_2000_abcdef01',
      'captured',
    );
    const result = await service.handleWebhook('mock', rawBody, headers);
    expect(result).toEqual({ received: true, matched: true });
    expect(payments[0].status).toBe(PaymentStatus.CAPTURED);
    expect(payments[0].capturedAt).toBeInstanceOf(Date);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payment.captured',
        entityId: 'pay-1',
      }),
      manager,
    );
    expect(settled).toHaveBeenCalledWith('t1', 'sale-1');
    expect(eventsRepo.update).toHaveBeenCalledWith(
      'evt-row-1',
      expect.objectContaining({ tenantId: 't1' }),
    );
  });

  it('never applies a webhook for another amount; keeps it for review', async () => {
    // The reference encodes 20.00; the payment is for 25.00
    payments[0].amount = 25;
    const { rawBody, headers } = mock.buildWebhook(
      'mock_1_2000_abcdef01',
      'captured',
    );
    const result = await service.handleWebhook('mock', rawBody, headers);
    expect(result).toEqual({ received: true, matched: false });
    expect(payments[0].status).toBe(PaymentStatus.PENDING);
    expect(settled).not.toHaveBeenCalled();
    expect(paymentsRepo.update).toHaveBeenCalledWith(
      { id: 'pay-1', tenantId: 't1' },
      {
        metadata: expect.objectContaining({ needsReview: true }) as unknown,
      },
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment.webhook_mismatch' }),
    );
    expect(eventsRepo.update).toHaveBeenCalledWith(
      'evt-row-1',
      expect.objectContaining({
        error: expect.stringContaining('does not match') as unknown,
      }),
    );
  });

  it('checks the currency when the provider sends one', () => {
    const payment = { amount: 20, currencyCode: 'USD' };
    expect(
      webhookMismatch(payment, {
        status: 'captured',
        amount: 2000,
        currencyCode: 'usd',
      }),
    ).toBeNull();
    expect(
      webhookMismatch(payment, {
        status: 'captured',
        amount: 2000,
        currencyCode: 'HTG',
      }),
    ).toContain('Currency HTG');
    // Events that take no money are not checked
    expect(
      webhookMismatch(payment, { status: 'failed', amount: 1 }),
    ).toBeNull();
  });

  it('acknowledges a redelivered event without applying it again', async () => {
    insertedIds = [];
    const { rawBody, headers } = mock.buildWebhook(
      'mock_1_2000_abcdef01',
      'captured',
      'evt_1',
    );
    const result = await service.handleWebhook('mock', rawBody, headers);
    expect(result).toEqual({ received: true, duplicate: true });
    expect(manager.update).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it('does not move a captured payment back on a late "authorized" event', async () => {
    payments[0].status = PaymentStatus.CAPTURED;
    const { rawBody, headers } = mock.buildWebhook(
      'mock_1_2000_abcdef01',
      'authorized',
    );
    await service.handleWebhook('mock', rawBody, headers);
    expect(payments[0].status).toBe(PaymentStatus.CAPTURED);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('records events for unknown references without failing', async () => {
    const { rawBody, headers } = mock.buildWebhook(
      'mock_9_100_ffffffff',
      'captured',
    );
    const result = await service.handleWebhook('mock', rawBody, headers);
    expect(result).toEqual({ received: true, matched: false });
    expect(eventsRepo.update).toHaveBeenCalledWith(
      'evt-row-1',
      expect.objectContaining({ error: 'No payment with this reference' }),
    );
  });

  it('marks a payment unknown when the provider times out, then resolves it by lookup', async () => {
    const payment = {
      id: 'pay-2',
      tenantId: 't1',
      saleId: 'sale-2',
      amount: 20.99,
      currencyCode: 'USD',
      status: PaymentStatus.INITIATED,
      provider: 'mock',
      providerReference: null,
      idempotencyKey: 'sale-2:p1',
      metadata: {},
      paymentMethod: { provider: 'mock' },
    } as unknown as Payment;
    payments = [payment];
    paymentsRepo.find.mockResolvedValueOnce([payment]);
    await service.startPayments('t1', 'sale-2');
    expect(payment.status).toBe(PaymentStatus.UNKNOWN);
    expect(payment.failureReason).toContain('did not respond');

    // The mock charged it anyway; the lookup by idempotency key finds it
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5000);
    await service.lookup('t1', 'pay-2');
    jest.restoreAllMocks();
    expect(payment.status).toBe(PaymentStatus.CAPTURED);
    expect(payment.providerReference).toMatch(/^mock_/);
    expect(settled).toHaveBeenCalledWith('t1', 'sale-2');
  });

  it('matches a webhook by attempt key when the reference never arrived (timeout)', async () => {
    const payment = {
      id: 'pay-3',
      tenantId: 't1',
      saleId: 'sale-3',
      amount: 5.99,
      status: PaymentStatus.UNKNOWN,
      provider: 'mock',
      providerReference: null,
      idempotencyKey: 'sale-3:p1',
      metadata: {},
    } as unknown as Payment;
    payments = [payment];
    await expect(
      mock.initiate({
        tenantId: 't1',
        paymentId: 'pay-3',
        saleId: 'sale-3',
        amount: 5.99,
        currencyCode: 'USD',
        idempotencyKey: 'sale-3:p1',
      }),
    ).rejects.toThrow();
    const { providerReference } = await mock.lookup({
      idempotencyKey: 'sale-3:p1',
    });
    const { rawBody, headers } = mock.buildWebhook(
      providerReference!,
      'captured',
    );
    const result = await service.handleWebhook('mock', rawBody, headers);
    expect(result).toEqual({ received: true, matched: true });
    expect(payment.status).toBe(PaymentStatus.CAPTURED);
    expect(payment.providerReference).toBe(providerReference);
  });

  it('records payment.captured in the transaction that captured it', async () => {
    const { rawBody, headers } = mock.buildWebhook(
      'mock_1_2000_abcdef01',
      'captured',
    );
    await service.handleWebhook('mock', rawBody, headers);
    expect(outbox.record).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        type: 'payment.captured',
        aggregateId: 'pay-1',
        payload: expect.objectContaining({
          saleId: 'sale-1',
          amount: 20,
        }) as unknown,
      }),
    );
  });
});
