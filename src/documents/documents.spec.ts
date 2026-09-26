import { FindOperator, QueryFailedError } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PERMISSIONS_KEY } from '../auth/decorators/permissions.decorator';
import { SYSTEM_ROLES } from '../auth/permissions';
import { SalesController } from '../sales/sales.controller';
import type { AuditService } from '../audit/audit.service';
import type { SettingsService } from '../settings/settings.service';
import type {
  EmailChannel,
  EmailMessage,
} from '../notifications/email/email-channel';
import { buildMessage } from '../notifications/email/smtp-email.channel';
import { PrintJobsService, type PrintActor } from './print-jobs.service';
import { DocumentDeliveriesService } from './document-deliveries.service';
import {
  canMoveTo,
  maskEmailsIn,
  maskRecipient,
  printPermissions,
  retryAs,
} from './print-job-rules';
import {
  receiptLinkKey,
  signReceiptLink,
  verifyReceiptLink,
} from './receipt-link';
import {
  renderReceiptHtml,
  renderReceiptText,
  type ReceiptView,
} from './receipt-html';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SALE = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const OTHER_USER = '44444444-4444-4444-8444-444444444444';

const cashier: PrintActor = {
  id: USER,
  permissions: SYSTEM_ROLES.cashier.permissions,
};

// ---------------------------------------------------------------------------
// In-memory tables standing in for Postgres

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected instanceof FindOperator) {
      const values = expected.value as unknown[];
      if (expected.type === 'moreThanOrEqual') {
        return (row[key] as Date) >= (expected.value as Date);
      }
      return expected.type === 'in' ? values.includes(row[key]) : false;
    }
    return row[key] === expected;
  });
}

function fakeRepo(rows: Row[], onInsert?: (row: Row) => void) {
  let seq = 0;
  return {
    rows,
    create: (value: Row) => ({ ...value }),
    save: jest.fn((value: Row) => {
      onInsert?.(value);
      const row = {
        id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
        createdAt: new Date(),
        ...value,
      };
      rows.push(row);
      return Promise.resolve(row);
    }),
    findOne: ({ where }: { where: Row }) =>
      Promise.resolve(rows.find((r) => matches(r, where)) ?? null),
    find: ({ where }: { where: Row }) =>
      Promise.resolve(rows.filter((r) => matches(r, where))),
    count: ({ where }: { where: Row }) =>
      Promise.resolve(rows.filter((r) => matches(r, where)).length),
    update: jest.fn((where: Row, patch: Row) => {
      const hits = rows.filter((r) => matches(r, where));
      hits.forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ affected: hits.length });
    }),
  };
}

const LIVE = ['queued', 'sent', 'printed', 'unknown'];

function uniqueViolation() {
  const error = new QueryFailedError('INSERT', [], new Error('duplicate'));
  (error as unknown as { driverError: unknown }).driverError = {
    code: '23505',
    constraint: 'UQ_print_jobs_original',
  };
  return error;
}

function printDb(saleStatus = 'completed') {
  const sale = {
    id: SALE,
    saleNumber: 'S-000001',
    status: saleStatus,
    receiptPrintCount: 0,
  };
  const jobs = fakeRepo([], (row) => {
    // UQ_print_jobs_original
    const clash = jobs.rows.some(
      (r) =>
        !r.copy &&
        !row.copy &&
        r.documentType === row.documentType &&
        r.documentId === row.documentId &&
        LIVE.includes(String(r.status)),
    );
    if (clash) throw uniqueViolation();
  });
  const query = jest.fn((sql: string) => {
    if (sql.includes('FROM "sales"')) {
      return Promise.resolve([
        { number: sale.saleNumber, status: sale.status },
      ]);
    }
    if (sql.includes('FROM "sale_returns"')) {
      return Promise.resolve([{ number: 'R-000001' }]);
    }
    if (sql.startsWith('UPDATE sales SET "receiptPrintCount"')) {
      sale.receiptPrintCount += 1;
      return Promise.resolve([
        [{ receiptPrintCount: sale.receiptPrintCount }],
        1,
      ]);
    }
    return Promise.resolve([]);
  });
  const manager = { getRepository: () => jobs, query };
  const dataSource = {
    transaction: (fn: (m: typeof manager) => unknown) => fn(manager),
    getRepository: () => jobs,
    query,
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new PrintJobsService(
    dataSource as never,
    audit as unknown as AuditService,
  );
  return { service, jobs, sale, audit, query };
}

// ---------------------------------------------------------------------------

describe('print jobs', () => {
  it('prints the original first, then numbered copies counted on the sale', async () => {
    const { service, sale, audit } = printDb();
    const original = await service.create(TENANT, cashier, {
      documentType: 'receipt',
      documentId: SALE,
    });
    expect(original).toMatchObject({
      copy: false,
      copyNumber: null,
      status: 'queued',
      documentNumber: 'S-000001',
    });
    await service.updateStatus(TENANT, original.id, { status: 'printed' });

    // The till asks for "the receipt" again: it can only be a copy
    const again = await service.create(TENANT, cashier, {
      documentType: 'receipt',
      documentId: SALE,
    });
    expect(again).toMatchObject({ copy: true, copyNumber: 1 });
    const third = await service.create(TENANT, cashier, {
      documentType: 'receipt',
      documentId: SALE,
      copy: true,
    });
    expect(third.copyNumber).toBe(2);
    expect(sale.receiptPrintCount).toBe(2);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'sale.receipt_reprinted',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        metadata: expect.objectContaining({ copyNumber: 2 }),
      }),
      expect.anything(),
    );
  });

  it('turns a concurrent second original into a copy (unique index)', async () => {
    const { service, jobs } = printDb();
    // Another till took the original between our check and our insert
    jobs.rows.push({
      id: 'other',
      tenantId: TENANT,
      documentType: 'receipt',
      documentId: SALE,
      copy: false,
      status: 'queued',
    });
    const findOne = jest.spyOn(jobs, 'findOne').mockResolvedValueOnce(null);
    const job = await service.create(TENANT, cashier, {
      documentType: 'receipt',
      documentId: SALE,
    });
    expect(job).toMatchObject({ copy: true, copyNumber: 1 });
    findOne.mockRestore();
  });

  it('follows the status lifecycle and refuses to reopen a finished job', async () => {
    const { service } = printDb();
    const job = await service.create(TENANT, cashier, {
      documentType: 'receipt',
      documentId: SALE,
    });
    await service.updateStatus(TENANT, job.id, { status: 'sent' });
    await service.updateStatus(TENANT, job.id, { status: 'unknown' });
    const settled = await service.updateStatus(TENANT, job.id, {
      status: 'printed',
    });
    expect(settled.status).toBe('printed');
    await expect(
      service.updateStatus(TENANT, job.id, { status: 'queued' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(canMoveTo('failed', 'printed')).toBe(false);
    expect(canMoveTo('queued', 'failed')).toBe(true);
  });

  it('retries an uncertain print as a labelled COPY, never a second original', async () => {
    const { service } = printDb();
    const job = await service.create(TENANT, cashier, {
      documentType: 'receipt',
      documentId: SALE,
      channel: 'bridge',
      printerId: 'front',
    });
    await service.updateStatus(TENANT, job.id, {
      status: 'unknown',
      error: 'timeout',
    });
    const retry = await service.retry(TENANT, cashier, job.id);
    expect(retry).toMatchObject({
      copy: true,
      copyNumber: 1,
      retryOfId: job.id,
      printerId: 'front',
      channel: 'bridge',
    });
  });

  it('retries a failed original as the original (nothing reached the printer)', async () => {
    const { service } = printDb();
    const job = await service.create(TENANT, cashier, {
      documentType: 'receipt',
      documentId: SALE,
    });
    await service.updateStatus(TENANT, job.id, {
      status: 'failed',
      error: 'ECONNREFUSED',
    });
    const retry = await service.retry(TENANT, cashier, job.id);
    expect(retry).toMatchObject({
      copy: false,
      copyNumber: null,
      retryOfId: job.id,
    });
  });

  it('settles a job still in flight as unknown before retrying it as a copy', async () => {
    const { service, jobs } = printDb();
    const job = await service.create(TENANT, cashier, {
      documentType: 'receipt',
      documentId: SALE,
    });
    const retry = await service.retry(TENANT, cashier, job.id);
    expect(jobs.rows.find((r) => r.id === job.id)?.status).toBe('unknown');
    expect(retry.copy).toBe(true);
  });

  it('does not retry a printed job', async () => {
    const { service } = printDb();
    const job = await service.create(TENANT, cashier, {
      documentType: 'receipt',
      documentId: SALE,
    });
    await service.updateStatus(TENANT, job.id, { status: 'printed' });
    await expect(service.retry(TENANT, cashier, job.id)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(retryAs({ status: 'printed', copy: false })).toBeNull();
  });

  it('needs sales.reprint for any copy', async () => {
    const { service } = printDb();
    const sellOnly: PrintActor = { id: USER, permissions: ['pos.sell'] };
    await service.create(TENANT, sellOnly, {
      documentType: 'receipt',
      documentId: SALE,
    });
    await expect(
      service.create(TENANT, sellOnly, {
        documentType: 'receipt',
        documentId: SALE,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(printPermissions('receipt', true)).toEqual(['sales.reprint']);
  });

  it('refuses receipts of unfinished sales', async () => {
    const { service } = printDb('held');
    await expect(
      service.create(TENANT, cashier, {
        documentType: 'receipt',
        documentId: SALE,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('records credit notes and labels with their own permissions and copy counters', async () => {
    const { service } = printDb();
    const manager: PrintActor = {
      id: USER,
      permissions: SYSTEM_ROLES.manager.permissions,
    };
    const note = await service.create(TENANT, manager, {
      documentType: 'credit_note',
      documentId: SALE,
    });
    expect(note).toMatchObject({ copy: false, documentNumber: 'R-000001' });
    const noteCopy = await service.create(TENANT, manager, {
      documentType: 'credit_note',
      documentId: SALE,
    });
    expect(noteCopy).toMatchObject({ copy: true, copyNumber: 1 });
    await expect(
      service.create(TENANT, cashier, {
        documentType: 'label',
        documentId: SALE,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('reprint permission', () => {
  it('is separate from viewing sales, and cashiers have it', () => {
    const required = Reflect.getMetadata(
      PERMISSIONS_KEY,
      // eslint-disable-next-line @typescript-eslint/unbound-method
      SalesController.prototype.reprint,
    ) as string[];
    expect(required).toEqual(['sales.reprint']);
    expect(SYSTEM_ROLES.cashier.permissions).toContain('sales.reprint');
    expect(SYSTEM_ROLES.cashier.permissions).not.toContain('hardware.manage');
    expect(SYSTEM_ROLES.manager.permissions).toContain('hardware.manage');
  });
});

// ---------------------------------------------------------------------------

const snapshot = {
  storeName: 'Corner <Shop>',
  businessLegalName: 'Corner Shop SA',
  businessAddressLine1: '1 Rue Pavée',
  businessAddressLine2: '',
  businessCity: 'Port-au-Prince',
  businessPostalCode: 'HT6110',
  businessState: '',
  businessCountry: 'Haïti',
  businessPhone: '+509 1234',
  businessEmail: 'shop@example.com',
  businessWebsite: '',
  businessTaxId: 'NIF-001',
  businessRegistrationNumber: '',
  businessLogoUrl: 'javascript:alert(1)',
  receiptHeader: '',
  receiptFooter: 'Merci !',
  returnPolicy: '',
  pricesIncludeTax: false,
};

function view(overrides: Partial<ReceiptView> = {}): ReceiptView {
  return {
    kind: 'receipt',
    saleNumber: 'S-000001',
    saleDate: '2026-09-01T10:00:00Z',
    status: 'completed',
    currencyCode: 'USD',
    subtotal: 10,
    discountAmount: 0,
    taxAmount: 1,
    total: 11,
    changeAmount: 0,
    seller: snapshot,
    items: [
      {
        productName: 'Café <b>noir</b>',
        variantName: null,
        sku: 'CAF',
        quantity: 2,
        unitPrice: 5,
        subtotal: 10,
        discountAmount: 0,
        taxRate: 10,
      },
    ],
    payments: [{ name: 'Cash', amount: 11, reference: null }],
    customer: {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      taxNumber: 'TX-9',
      address: '2 Main St\nLondon',
    },
    cashier: 'Grace Hopper',
    lang: 'en',
    ...overrides,
  };
}

describe('server-rendered receipt', () => {
  it('escapes every value and drops non-https logos', () => {
    const html = renderReceiptHtml(view());
    expect(html).toContain('Café &lt;b&gt;noir&lt;/b&gt;');
    expect(html).toContain('Corner &lt;Shop&gt;');
    expect(html).not.toContain('javascript:');
    expect(html).not.toMatch(/<script/i);
  });

  it('shows buyer fields on invoices only', () => {
    const invoice = renderReceiptHtml(view({ kind: 'invoice' }));
    expect(invoice).toContain('Invoice');
    expect(invoice).toContain('Bill to');
    expect(invoice).toContain('TX-9');
    expect(invoice).toContain('2 Main St');
    const receipt = renderReceiptHtml(view());
    expect(receipt).not.toContain('Bill to');
  });

  it('labels copies and speaks the store language', () => {
    const html = renderReceiptHtml(view({ copyNumber: 2, lang: 'fr' }));
    expect(html).toContain('COPIE — NON ORIGINAL #2');
    expect(html).toContain('Ticket de caisse');
  });
});

// ---------------------------------------------------------------------------

function deliveriesFixture(
  options: { enabled?: boolean; fail?: boolean | string } = {},
) {
  const rows: Row[] = [];
  const repo = fakeRepo(rows);
  const sent: EmailMessage[] = [];
  const email: EmailChannel = {
    enabled: options.enabled ?? true,
    send: (message) => {
      if (options.fail)
        return Promise.reject(
          new Error(
            typeof options.fail === 'string'
              ? options.fail
              : '550 mailbox unavailable',
          ),
        );
      sent.push(message);
      return Promise.resolve();
    },
  };
  const dataSource = { getRepository: () => repo };
  const settings = {
    getSettings: jest.fn().mockResolvedValue({ language: 'en' }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new DocumentDeliveriesService(
    dataSource as never,
    settings as unknown as SettingsService,
    audit as unknown as AuditService,
    email,
  );
  const sale = {
    id: SALE,
    saleNumber: 'S-000001',
    saleDate: new Date('2026-09-01T10:00:00Z'),
    status: 'completed',
    currencyCode: 'USD',
    subtotal: 10,
    discountAmount: 0,
    taxAmount: 1,
    total: 11,
    changeAmount: 0,
    documentSnapshot: snapshot,
    items: view().items,
    payments: [
      {
        amount: 11,
        status: 'completed',
        reference: null,
        paymentMethod: { name: { en: 'Cash' } },
      },
    ],
    customer: {
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@example.com',
      marketingEmailConsent: true,
      metadata: {},
    },
    user: { firstName: 'Grace', lastName: 'Hopper' },
  };
  jest
    .spyOn(
      service as unknown as { loadSale: () => Promise<unknown> },
      'loadSale',
    )
    .mockResolvedValue(sale);
  return { service, rows, sent, audit, sale };
}

describe('e-mailed receipts', () => {
  it('sends a confirmed receipt and records the delivery', async () => {
    const { service, rows, sent, audit } = deliveriesFixture();
    const result = await service.emailReceipt(TENANT, USER, SALE, {
      to: 'ADA@example.com',
      consentConfirmed: true,
    });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('ada@example.com');
    expect(sent[0].html).toContain('S-000001');
    expect(sent[0].text).toContain('TOTAL');
    expect(rows[0]).toMatchObject({
      channel: 'email',
      status: 'sent',
      consentBasis: 'cashier_confirmed',
    });
    // The API and the audit log never show the full address
    expect(result.recipient).toBe('ad***@example.com');
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      'ada@example.com',
    );
  });

  it('requires consent for any other address', async () => {
    const { service, rows, sent } = deliveriesFixture();
    await expect(
      service.emailReceipt(TENANT, USER, SALE, { to: 'someone@example.com' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(sent).toHaveLength(0);
    expect(rows).toHaveLength(0);
    await service.emailReceipt(TENANT, USER, SALE, {
      to: 'someone@example.com',
      consentConfirmed: true,
    });
    expect(rows[0]).toMatchObject({
      consentBasis: 'cashier_confirmed',
      status: 'sent',
    });
  });

  it('never treats marketing consent as consent to e-mail a receipt', async () => {
    const { service, sale, sent } = deliveriesFixture();
    expect(sale.customer.marketingEmailConsent).toBe(true);
    await expect(
      service.emailReceipt(TENANT, USER, SALE, { to: 'ada@example.com' }),
    ).rejects.toMatchObject({
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      response: expect.objectContaining({ code: 'CONSENT_REQUIRED' }),
    });
    expect(sent).toHaveLength(0);
  });

  it("shows the buyer block only when sent to the customer's own address", async () => {
    const { service, sent } = deliveriesFixture();
    const dto = { consentConfirmed: true, documentType: 'invoice' as const };
    await service.emailReceipt(TENANT, USER, SALE, {
      ...dto,
      to: 'Ada@Example.com',
    });
    expect(sent[0].html).toContain('Bill to');
    expect(sent[0].html).toContain('Ada Lovelace');
    await service.emailReceipt(TENANT, USER, SALE, {
      ...dto,
      to: 'stranger@example.com',
    });
    expect(sent[1].html).not.toContain('Bill to');
    expect(sent[1].html).not.toContain('Lovelace');
    expect(sent[1].html).not.toContain('ada@example.com');
  });

  it('caps e-mails per user per minute and per sale per 24 h', async () => {
    const { service, rows, sent } = deliveriesFixture();
    const dto = { to: 'ada@example.com', consentConfirmed: true };
    const t0 = new Date('2026-09-01T10:00:00Z');
    for (let i = 0; i < 5; i++) {
      await service.emailReceipt(TENANT, USER, SALE, dto, t0);
    }
    rows.forEach((r) => (r.createdAt = t0));
    // 6th in the same minute: per-user limit
    await expect(
      service.emailReceipt(TENANT, USER, SALE, dto, t0),
    ).rejects.toMatchObject({
      status: 429,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      response: expect.objectContaining({ code: 'EMAIL_RATE_LIMITED' }),
    });
    // Later that day, another cashier: per-sale limit
    const later = new Date('2026-09-01T20:00:00Z');
    await expect(
      service.emailReceipt(TENANT, OTHER_USER, SALE, dto, later),
    ).rejects.toMatchObject({
      status: 429,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      response: expect.objectContaining({ code: 'EMAIL_LIMIT_REACHED' }),
    });
    expect(sent).toHaveLength(5);
    expect(rows).toHaveLength(5);
    // A day later the window has rolled
    await service.emailReceipt(
      TENANT,
      OTHER_USER,
      SALE,
      dto,
      new Date('2026-09-02T10:00:01Z'),
    );
    expect(sent).toHaveLength(6);
  });

  it('records failures (SMTP error, e-mail disabled)', async () => {
    const failing = deliveriesFixture({ fail: true });
    await expect(
      failing.service.emailReceipt(TENANT, USER, SALE, {
        to: 'ada@example.com',
        consentConfirmed: true,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(failing.rows[0]).toMatchObject({
      status: 'failed',
      error: '550 mailbox unavailable',
    });

    const disabled = deliveriesFixture({ enabled: false });
    await expect(
      disabled.service.emailReceipt(TENANT, USER, SALE, {
        to: 'ada@example.com',
        consentConfirmed: true,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(disabled.rows[0]).toMatchObject({ status: 'failed' });
  });

  it('masks addresses echoed back in SMTP errors', async () => {
    const failing = deliveriesFixture({
      fail: '550 5.1.1 <ada@example.com>: Recipient address rejected',
    });
    await expect(
      failing.service.emailReceipt(TENANT, USER, SALE, {
        to: 'ada@example.com',
        consentConfirmed: true,
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(failing.rows[0].error).toBe(
      '550 5.1.1 <ad***@example.com>: Recipient address rejected',
    );
    expect(JSON.stringify(failing.audit.record.mock.calls)).not.toContain(
      'ada@example.com',
    );
    expect(maskEmailsIn('to a.b+c@mail.example.org, and x@y.io')).toBe(
      'to a.***@mail.example.org, and x***@y.io',
    );
  });

  it('builds a multipart message when there is HTML', () => {
    const raw = buildMessage('pos@example.com', {
      to: 'a@example.com',
      subject: 'Reçu',
      text: 'Hello',
      html: '<p>Hello</p>',
    });
    expect(raw).toContain('multipart/alternative');
    expect(raw).toContain('Content-Type: text/html; charset=utf-8');
    const plain = buildMessage('pos@example.com', {
      to: 'a@example.com',
      subject: 'x',
      text: 'Hello',
    });
    expect(plain).toContain('Content-Type: text/plain; charset=utf-8');
    expect(plain).not.toContain('multipart');
  });

  it('masks recipients', () => {
    expect(maskRecipient('jo@example.com')).toBe('j***@example.com');
    expect(maskRecipient('+509 3712 3456')).toBe('****56');
    expect(maskRecipient(null)).toBeNull();
  });
});

describe('shared receipt links', () => {
  const key = receiptLinkKey({
    JWT_SECRET: 'a-test-secret-that-is-long-enough-000',
  });
  const claims = {
    tenantId: TENANT,
    saleId: SALE,
    deliveryId: USER,
    expiresAt: new Date('2026-10-01T00:00:00Z'),
  };

  it('verifies until the expiry, then reports it expired', () => {
    const token = signReceiptLink(claims, key);
    expect(
      verifyReceiptLink(token, key, new Date('2026-09-30T23:59:00Z')),
    ).toMatchObject({ ok: true, claims: { saleId: SALE } });
    expect(
      verifyReceiptLink(token, key, new Date('2026-10-01T00:00:01Z')),
    ).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects tampered or foreign tokens', () => {
    const token = signReceiptLink(claims, key);
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ v: 1, t: TENANT, s: SALE, d: USER, e: 9999999999 }),
    ).toString('base64url');
    expect(verifyReceiptLink(`${forged}.${signature}`, key).ok).toBe(false);
    expect(
      verifyReceiptLink(
        token,
        receiptLinkKey({ JWT_SECRET: 'another-secret-another-secret-0000' }),
      ).ok,
    ).toBe(false);
    expect(verifyReceiptLink(`${payload}`, key)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('serves the receipt page until the link expires or is revoked', async () => {
    const { service, rows, audit } = deliveriesFixture();
    const now = new Date('2026-09-01T00:00:00Z');
    const link = await service.createShareLink(
      TENANT,
      USER,
      SALE,
      { expiresInDays: 7 },
      now,
    );
    expect(link.path).toBe(`/public/receipts/${link.token}`);
    expect(rows[0]).toMatchObject({ channel: 'sms_link', status: 'sent' });
    await expect(service.publicReceiptHtml(link.token, now)).resolves.toContain(
      'S-000001',
    );
    await expect(
      service.publicReceiptHtml(link.token, new Date('2026-09-09T00:00:00Z')),
    ).rejects.toBeInstanceOf(GoneException);
    audit.record.mockClear();
    await service.revoke(TENANT, String(rows[0].id));
    expect(audit.record).toHaveBeenCalledWith({
      tenantId: TENANT,
      action: 'sale.receipt_link_revoked',
      entityType: 'sale',
      entityId: SALE,
      metadata: { deliveryId: rows[0].id, documentId: SALE },
    });
    await expect(
      service.publicReceiptHtml(link.token, now),
    ).rejects.toBeInstanceOf(GoneException);
    await expect(
      service.publicReceiptHtml('nope.nope', now),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('server-rendered receipt: measured (weighed) lines', () => {
  const weighed = view({
    items: [
      {
        productName: 'Apples',
        variantName: null,
        sku: 'APL',
        quantity: 1.25,
        unitPrice: 3.99,
        subtotal: 4.99,
        discountAmount: 0,
        taxRate: 0,
        unit: 'kg',
        unitPrecision: 3,
      },
    ],
  });

  it('prints the quantity with its unit and the price per unit', () => {
    const html = renderReceiptHtml(weighed);
    expect(html).toContain('1.250 kg');
    expect(html).toContain('/kg');
    expect(renderReceiptText(weighed)).toContain(
      '1.250 kg x $3.99/kg Apples  $4.99',
    );
  });

  it('leaves piece lines as whole numbers', () => {
    expect(renderReceiptText(view())).toContain('2 x Café <b>noir</b>');
  });
});
