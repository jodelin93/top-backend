import { MOCK_SIGNATURE_HEADER, MockPaymentProvider } from './mock.provider';
import { InvalidWebhookError, ProviderTimeoutError } from './payment-provider';

const request = (amount: number, idempotencyKey = `k-${amount}`) => ({
  tenantId: 't',
  paymentId: 'p',
  saleId: 's',
  amount,
  currencyCode: 'USD',
  idempotencyKey,
});

describe('MockPaymentProvider', () => {
  const secret = 'test-secret';
  let provider: MockPaymentProvider;

  beforeEach(() => {
    jest.useFakeTimers();
    provider = new MockPaymentProvider({
      delayMs: 1000,
      secret,
      sendWebhooks: true,
    });
  });
  afterEach(() => jest.useRealTimers());

  it('authorises asynchronously, then captures', async () => {
    const started = await provider.initiate(request(20));
    expect(started.status).toBe('pending');
    const ref = started.providerReference!;

    jest.advanceTimersByTime(600);
    expect(
      (await provider.lookup({ providerReference: ref, idempotencyKey: 'x' }))
        .status,
    ).toBe('authorized');
    jest.advanceTimersByTime(500);
    expect(
      (await provider.lookup({ providerReference: ref, idempotencyKey: 'x' }))
        .status,
    ).toBe('captured');
  });

  it('is idempotent per key', async () => {
    const a = await provider.initiate(request(20, 'same'));
    const b = await provider.initiate(request(20, 'same'));
    expect(b.providerReference).toBe(a.providerReference);
  });

  it('declines amounts ending in .13', async () => {
    const result = await provider.initiate(request(20.13));
    expect(result).toMatchObject({
      status: 'failed',
      failureReason: 'Card declined',
    });
  });

  it('times out on .99 but the charge can be found by idempotency key', async () => {
    await expect(
      provider.initiate(request(20.99, 'slow')),
    ).rejects.toBeInstanceOf(ProviderTimeoutError);
    jest.advanceTimersByTime(1500);
    const found = await provider.lookup({ idempotencyKey: 'slow' });
    expect(found.status).toBe('captured');
    expect(found.providerReference).toMatch(/^mock_/);
  });

  it('reports a payment it never saw as failed', async () => {
    expect((await provider.lookup({ idempotencyKey: 'never' })).status).toBe(
      'failed',
    );
  });

  it('cancels before capture and refunds after', async () => {
    const pending = await provider.initiate(request(10));
    expect((await provider.cancel(pending.providerReference!)).status).toBe(
      'cancelled',
    );

    const other = await provider.initiate(request(11));
    jest.advanceTimersByTime(1100);
    expect((await provider.cancel(other.providerReference!)).status).toBe(
      'captured',
    );
    expect((await provider.refund(other.providerReference!)).status).toBe(
      'refunded',
    );
  });

  it('sends signed webhooks for authorisation and capture', async () => {
    const delivered: { rawBody: string; headers: Record<string, string> }[] =
      [];
    provider.onWebhook((req) => {
      delivered.push(req);
      return Promise.resolve();
    });
    await provider.initiate(request(30));
    jest.advanceTimersByTime(1100);
    expect(delivered).toHaveLength(2);
    const events = delivered.map((d) =>
      provider.verifyWebhook({
        rawBody: d.rawBody,
        headers: d.headers,
        secret,
      }),
    );
    expect(events.map((e) => e.status)).toEqual(['authorized', 'captured']);
    expect(events[0].eventId).not.toBe(events[1].eventId);
  });

  it('rejects webhooks with a bad or missing signature', () => {
    const { rawBody, headers } = provider.buildWebhook(
      'mock_1_100_abc',
      'captured',
    );
    expect(() =>
      provider.verifyWebhook({ rawBody: rawBody + ' ', headers, secret }),
    ).toThrow(InvalidWebhookError);
    expect(() =>
      provider.verifyWebhook({
        rawBody,
        headers: { [MOCK_SIGNATURE_HEADER]: 'sha256=00' },
        secret,
      }),
    ).toThrow(InvalidWebhookError);
    expect(() =>
      provider.verifyWebhook({ rawBody, headers, secret: 'other' }),
    ).toThrow(InvalidWebhookError);
    expect(() =>
      provider.verifyWebhook({ rawBody, headers, secret: null }),
    ).toThrow(InvalidWebhookError);
    expect(provider.verifyWebhook({ rawBody, headers, secret }).status).toBe(
      'captured',
    );
  });
});
