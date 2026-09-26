import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { canAccessBranch, hasAllBranches } from '../auth/branch-scope';
import { DataSource, MoreThanOrEqual } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { Sale } from '../database/entities/sale.entity';
import {
  EMAIL_CHANNEL,
  type EmailChannel,
} from '../notifications/email/email-channel';
import { SettingsService } from '../settings/settings.service';
import { buildDocumentSnapshot } from '../sales/document-snapshot';
import {
  DocumentDelivery,
  type ConsentBasis,
} from './document-delivery.entity';
import {
  maskEmailsIn,
  maskRecipient,
  UNPRINTABLE_SALE_STATUSES,
} from './print-job-rules';
import {
  receiptSubject,
  renderReceiptHtml,
  renderReceiptText,
  type ReceiptView,
} from './receipt-html';
import {
  receiptLinkKey,
  signReceiptLink,
  verifyReceiptLink,
} from './receipt-link';
import type { EmailReceiptDto, ShareLinkDto } from './documents.dto';

const DEFAULT_LINK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
// Anti-relay caps on e-mailed receipts (the route also has a @Throttle limit)
export const EMAIL_LIMIT_PER_SALE = 5; // per sale, rolling 24 h
export const EMAIL_LIMIT_PER_USER = 5; // per user, rolling minute
const MINUTE_MS = 60 * 1000;

const personName = (
  p: { firstName?: string | null; lastName?: string | null } | null | undefined,
) => [p?.firstName, p?.lastName].filter(Boolean).join(' ').trim();

/** Customer address when the store keeps one (customers.metadata.address) */
function customerAddress(metadata: unknown): string | null {
  const address = (metadata as { address?: unknown } | null)?.address;
  if (typeof address === 'string') return address.trim() || null;
  if (address && typeof address === 'object') {
    const a = address as Record<string, unknown>;
    const text = [
      a.line1,
      a.line2,
      [a.postalCode, a.city].filter(Boolean).join(' '),
      [a.state, a.country].filter(Boolean).join(', '),
    ]
      .filter((v) => typeof v === 'string' && v.trim())
      .join('\n');
    return text || null;
  }
  return null;
}

/**
 * Receipts sent outside the till (spec §15): e-mailed with the customer's consent
 * (or the cashier's confirmation that the customer asked for it), or shared as a
 * signed, expiring read-only link. Each send is a document_deliveries row.
 */
@Injectable()
export class DocumentDeliveriesService {
  private readonly logger = new Logger(DocumentDeliveriesService.name);
  private readonly linkKey = receiptLinkKey();

  constructor(
    private dataSource: DataSource,
    private settingsService: SettingsService,
    private auditService: AuditService,
    @Inject(EMAIL_CHANNEL) private email: EmailChannel,
  ) {}

  async emailReceipt(
    tenantId: string,
    userId: string,
    saleId: string,
    dto: EmailReceiptDto,
    now: Date = new Date(),
  ) {
    const to = dto.to.trim().toLowerCase();
    const sale = await this.loadSale(tenantId, saleId);
    const consentBasis = this.consentFor(dto.consentConfirmed);
    const documentType = dto.documentType ?? 'receipt';

    const repo = this.dataSource.getRepository(DocumentDelivery);
    await this.assertEmailQuota(tenantId, userId, sale.id, now);
    const delivery = await repo.save(
      repo.create({
        tenantId,
        documentType,
        documentId: sale.id,
        channel: 'email',
        recipient: to,
        status: 'queued',
        consentBasis,
        userId,
      }),
    );
    const finish = async (status: 'sent' | 'failed', error: string | null) => {
      await repo.update(
        { id: delivery.id, tenantId },
        { status, error, updatedAt: new Date() },
      );
      await this.auditService.record({
        tenantId,
        action:
          status === 'sent'
            ? 'sale.receipt_emailed'
            : 'sale.receipt_email_failed',
        entityType: 'sale',
        entityId: sale.id,
        metadata: {
          saleNumber: sale.saleNumber,
          to: maskRecipient(to),
          consentBasis,
          deliveryId: delivery.id,
          error,
        },
      });
      return this.present({ ...delivery, status, error });
    };

    if (!this.email.enabled) {
      await finish('failed', 'E-mail is not configured on this server');
      throw new ServiceUnavailableException({
        message: 'E-mail is not configured on this server',
        code: 'EMAIL_DISABLED',
      });
    }
    // The buyer block (name, address, e-mail, tax no.) goes only to the
    // customer's own address: a copy sent elsewhere must not disclose it
    const toCustomer =
      !!sale.customer?.email && sale.customer.email.trim().toLowerCase() === to;
    const view = await this.viewOf(tenantId, sale, documentType, {
      includeCustomer: toCustomer,
    });
    try {
      await this.email.send({
        to,
        subject: receiptSubject(view),
        text: renderReceiptText(view),
        html: renderReceiptHtml(view),
      });
    } catch (error) {
      // SMTP servers often echo the recipient back: mask it before logging/storing
      const message = maskEmailsIn(
        error instanceof Error ? error.message : String(error),
      );
      this.logger.warn(
        `Receipt ${sale.saleNumber} to ${maskRecipient(to)} failed: ${message}`,
      );
      await finish('failed', message.slice(0, 500));
      throw new ServiceUnavailableException({
        message: 'The receipt could not be e-mailed. Try again later.',
        code: 'EMAIL_SEND_FAILED',
        retryable: true,
      });
    }
    this.logger.log(
      `Receipt ${sale.saleNumber} e-mailed to ${maskRecipient(to)}`,
    );
    return finish('sent', null);
  }

  /** A signed, expiring link to the receipt page, to share by SMS / WhatsApp */
  async createShareLink(
    tenantId: string,
    userId: string,
    saleId: string,
    dto: ShareLinkDto,
    now: Date = new Date(),
  ) {
    const sale = await this.loadSale(tenantId, saleId);
    const expiresAt = new Date(
      now.getTime() + (dto.expiresInDays ?? DEFAULT_LINK_DAYS) * DAY_MS,
    );
    const repo = this.dataSource.getRepository(DocumentDelivery);
    const delivery = await repo.save(
      repo.create({
        tenantId,
        documentType: 'receipt',
        documentId: sale.id,
        channel: 'sms_link',
        recipient: dto.recipient?.trim() || null,
        // The link is created; the cashier sends it from their own phone/app
        status: 'sent',
        consentBasis: null,
        expiresAt,
        userId,
      }),
    );
    const token = signReceiptLink(
      { tenantId, saleId: sale.id, deliveryId: delivery.id, expiresAt },
      this.linkKey,
    );
    await this.auditService.record({
      tenantId,
      action: 'sale.receipt_link_created',
      entityType: 'sale',
      entityId: sale.id,
      metadata: {
        saleNumber: sale.saleNumber,
        deliveryId: delivery.id,
        to: maskRecipient(delivery.recipient),
        expiresAt: expiresAt.toISOString(),
      },
    });
    return {
      delivery: this.present(delivery),
      token,
      // Relative to the API base URL (e.g. https://api.example.com/api/v1)
      path: `/public/receipts/${token}`,
      expiresAt,
    };
  }

  /** Revoke a shared link (its page then answers 410) */
  async revoke(tenantId: string, id: string) {
    const repo = this.dataSource.getRepository(DocumentDelivery);
    const delivery = await repo.findOne({
      where: { id, tenantId, channel: 'sms_link' },
    });
    if (!delivery) throw new NotFoundException('Shared link not found');
    await this.assertSaleBranch(
      tenantId,
      delivery.documentId,
      'Shared link not found',
    );
    const result = await repo.update(
      { id, tenantId, channel: 'sms_link' },
      { status: 'revoked', updatedAt: new Date() },
    );
    if (!result.affected) throw new NotFoundException('Shared link not found');
    // Link and document ids only: never the recipient
    await this.auditService.record({
      tenantId,
      action: 'sale.receipt_link_revoked',
      entityType: 'sale',
      entityId: delivery.documentId,
      metadata: { deliveryId: id, documentId: delivery.documentId },
    });
    return { id, status: 'revoked' };
  }

  /** HTML of the public receipt page; throws 404/410 for bad or expired links */
  async publicReceiptHtml(token: string, now: Date = new Date()) {
    const result = verifyReceiptLink(token, this.linkKey, now);
    if (!result.ok) {
      if (result.reason === 'expired') {
        throw new GoneException('This receipt link has expired');
      }
      throw new NotFoundException('Receipt not found');
    }
    const { tenantId, saleId, deliveryId } = result.claims;
    const delivery = await this.dataSource
      .getRepository(DocumentDelivery)
      .findOne({ where: { id: deliveryId, tenantId } });
    if (!delivery || delivery.documentId !== saleId) {
      throw new NotFoundException('Receipt not found');
    }
    if (delivery.status === 'revoked') {
      throw new GoneException('This receipt link was withdrawn');
    }
    const sale = await this.loadSale(tenantId, saleId);
    return renderReceiptHtml(await this.viewOf(tenantId, sale, 'receipt'));
  }

  /** E-mails and links sent for a document, newest first (recipients masked) */
  async list(tenantId: string, documentId: string) {
    await this.assertSaleBranch(tenantId, documentId);
    const rows = await this.dataSource.getRepository(DocumentDelivery).find({
      where: { tenantId, documentId },
      order: { createdAt: 'DESC' },
      take: 100,
    });
    return rows.map((row) => this.present(row));
  }

  // ---------------------------------------------------------------------------

  /**
   * E-mail needs a basis: the cashier confirms the customer asked for this receipt.
   *
   * Customers have no transactional-e-mail consent flag, only marketing consent
   * (marketingEmailConsent), and marketing consent is not a basis for sending a
   * receipt — it covers a different purpose and must not silently widen who may
   * be e-mailed. So every e-mailed receipt, even to the customer's own address,
   * needs the cashier's confirmation. ('customer_consent' stays in the type for
   * rows written before this rule.)
   */
  consentFor(confirmed: boolean | undefined): ConsentBasis {
    if (confirmed) return 'cashier_confirmed';
    throw new BadRequestException({
      message:
        'Confirm that the customer asked to receive this receipt by e-mail',
      code: 'CONSENT_REQUIRED',
    });
  }

  /**
   * 429 when the user sent too many receipt e-mails this minute, or the sale
   * already had EMAIL_LIMIT_PER_SALE e-mails (sent or failed) in the last 24 h:
   * the endpoint must not become a way to send mail to arbitrary addresses.
   */
  private async assertEmailQuota(
    tenantId: string,
    userId: string,
    saleId: string,
    now: Date,
  ) {
    const repo = this.dataSource.getRepository(DocumentDelivery);
    const perUser = await repo.count({
      where: {
        tenantId,
        userId,
        channel: 'email',
        createdAt: MoreThanOrEqual(new Date(now.getTime() - MINUTE_MS)),
      },
    });
    if (perUser >= EMAIL_LIMIT_PER_USER) {
      throw new HttpException(
        {
          message:
            'Too many receipt e-mails sent in the last minute. Try again shortly.',
          code: 'EMAIL_RATE_LIMITED',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const perSale = await repo.count({
      where: {
        tenantId,
        documentId: saleId,
        channel: 'email',
        createdAt: MoreThanOrEqual(new Date(now.getTime() - DAY_MS)),
      },
    });
    if (perSale >= EMAIL_LIMIT_PER_SALE) {
      throw new HttpException(
        {
          message: `This receipt was already e-mailed ${EMAIL_LIMIT_PER_SALE} times in the last 24 hours. Share a link or print it instead.`,
          code: 'EMAIL_LIMIT_REACHED',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  private present(row: DocumentDelivery) {
    return {
      id: row.id,
      documentType: row.documentType,
      documentId: row.documentId,
      channel: row.channel,
      recipient: maskRecipient(row.recipient),
      status: row.status,
      error: row.error,
      consentBasis: row.consentBasis,
      expiresAt: row.expiresAt,
      userId: row.userId,
      createdAt: row.createdAt,
    };
  }

  /** 404 when the document is a sale of a branch the user may not see */
  private async assertSaleBranch(
    tenantId: string,
    saleId: string,
    notFound = 'Sale not found',
  ) {
    if (hasAllBranches()) return;
    const sale = await this.dataSource.getRepository(Sale).findOne({
      where: { id: saleId, tenantId },
      select: { id: true, branchId: true },
    });
    if (sale && !canAccessBranch(sale.branchId)) {
      throw new NotFoundException(notFound);
    }
  }

  private async loadSale(tenantId: string, id: string): Promise<Sale> {
    const sale = await this.dataSource
      .getRepository(Sale)
      .createQueryBuilder('sale')
      .leftJoinAndSelect('sale.items', 'items')
      .leftJoinAndSelect('sale.payments', 'payments')
      .leftJoinAndSelect('payments.paymentMethod', 'paymentMethod')
      .leftJoinAndSelect('sale.customer', 'customer')
      .leftJoinAndSelect('sale.branch', 'branch')
      .leftJoin('sale.user', 'user')
      .addSelect(['user.id', 'user.firstName', 'user.lastName'])
      .where('sale.id = :id AND sale.tenantId = :tenantId', { id, tenantId })
      .orderBy('items.lineNumber', 'ASC')
      .getOne();
    // Another branch's sale is "not found" (spec §9); the public link has no user
    if (!sale || !canAccessBranch(sale.branchId)) {
      throw new NotFoundException('Sale not found');
    }
    if (UNPRINTABLE_SALE_STATUSES.includes(sale.status)) {
      throw new ConflictException('Only finished sales have a receipt');
    }
    return sale;
  }

  private async viewOf(
    tenantId: string,
    sale: Sale,
    kind: 'receipt' | 'invoice',
    options: { includeCustomer?: boolean } = {},
  ): Promise<ReceiptView> {
    const settings = await this.settingsService.getSettings(tenantId);
    // Frozen seller identity; sales from before snapshots use today's settings
    const seller =
      sale.documentSnapshot ??
      (sale.branch ? buildDocumentSnapshot(settings, sale.branch) : null);
    const lang = settings.language === 'fr' ? 'fr' : 'en';
    const paid = (sale.payments ?? []).filter(
      (p) => !['failed', 'cancelled'].includes(String(p.status)),
    );
    return {
      kind,
      saleNumber: sale.saleNumber,
      saleDate: sale.saleDate,
      status: sale.status,
      currencyCode: sale.currencyCode,
      subtotal: Number(sale.subtotal),
      discountAmount: Number(sale.discountAmount),
      taxAmount: Number(sale.taxAmount),
      total: Number(sale.total),
      changeAmount: Number(sale.changeAmount),
      seller: seller ?? {
        ...settings,
        pricesIncludeTax: !!settings.pricesIncludeTax,
      },
      items: (sale.items ?? []).map((i) => ({
        productName: i.productName,
        variantName: i.variantName ?? null,
        sku: i.sku ?? null,
        quantity: Number(i.quantity),
        unitPrice: Number(i.unitPrice),
        subtotal: Number(i.subtotal),
        discountAmount: Number(i.discountAmount),
        taxRate:
          i.taxRate === null || i.taxRate === undefined
            ? null
            : Number(i.taxRate),
        unit: (i.metadata?.unit as string | undefined) ?? null,
        unitPrecision:
          (i.metadata?.unitPrecision as number | undefined) ?? null,
      })),
      payments: paid.map((p) => ({
        name:
          p.paymentMethod?.name?.[lang] ??
          p.paymentMethod?.name?.en ??
          Object.values(p.paymentMethod?.name ?? {})[0] ??
          'Payment',
        amount: Number(p.amount),
        reference: p.reference ?? null,
      })),
      customer:
        sale.customer && options.includeCustomer !== false
          ? {
              name:
                sale.customer.companyName ||
                personName(sale.customer) ||
                sale.customer.code,
              email: sale.customer.email ?? null,
              taxNumber: sale.customer.taxNumber ?? null,
              address: customerAddress(sale.customer.metadata),
            }
          : null,
      cashier: personName(sale.user) || null,
      lang,
    };
  }
}
