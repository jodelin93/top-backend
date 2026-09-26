import { createHash } from 'crypto';
import { AuditService } from '../audit/audit.service';
import {
  LOYALTY_METHOD_CODE,
  LoyaltyService,
} from '../loyalty/loyalty.service';
import { EstimatesService } from '../estimates/estimates.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThan, Repository } from 'typeorm';
import { Sale, SaleStatus, SaleType } from '../database/entities/sale.entity';
import { SaleItem } from '../database/entities/sale-item.entity';
import { Payment, PaymentStatus } from '../database/entities/payment.entity';
import { Register, RegisterStatus } from '../database/entities/register.entity';
import { Branch } from '../database/entities/branch.entity';
import { Customer, CustomerStatus } from '../database/entities/customer.entity';
import {
  ProductVariant,
  VariantStatus,
} from '../database/entities/product-variant.entity';
import { ProductStatus } from '../database/entities/product.entity';
import {
  PaymentMethod,
  PaymentMethodStatus,
  PaymentMethodType,
} from '../database/entities/payment-method.entity';
import { Discount } from '../database/entities/discount.entity';
import { MovementType } from '../database/entities/stock-movement.entity';
import { StockLevel } from '../database/entities/stock-level.entity';
import { ReservationStatus } from '../database/entities/stock-reservation.entity';
import { User } from '../database/entities/user.entity';
import { TenantMembership } from '../database/entities/tenant-membership.entity';
import { Device } from '../devices/device.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import type { Permission } from '../auth/permissions';
import {
  branchDocumentPrefix,
  nextDocumentNumber,
} from '../common/utils/sequence';
import { ConflictCaseType } from '../database/entities/conflict-case.entity';
import { openConflictCase } from './conflict-cases.service';
import { buildDocumentSnapshot } from './document-snapshot';
import { sellingStaff } from './staff';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { paginate, PaginatedResult } from '../common/dto/pagination.dto';
import { requestContext } from '../common/context/request-context';
import {
  assertBranchAccess,
  branchFilterSql,
  canAccessBranch,
} from '../auth/branch-scope';
import { SettingsService, StoreSettings } from '../settings/settings.service';
import { PricingService } from '../price-lists/pricing.service';
import { DiscountsService } from '../discounts/discounts.service';
import { InventoryService } from '../inventory/inventory.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ShiftsService } from '../shifts/shifts.service';
import { Shift, ShiftStatus } from '../database/entities/shift.entity';
import { PaymentsService } from '../payments/payments.service';
import { summarizePayments } from '../payments/payment-state';
import {
  calculateSale,
  CalcLineInput,
  CalcOptions,
  CalcResult,
  round2,
} from './sale-calculator';
import { addQty, subQty } from '../common/utils/quantity';
import {
  assertQuantitiesFit,
  catalogUnit,
  unitMetadata,
  unitOfVariant,
  VARIANT_UNIT_RELATIONS,
  VariantUnit,
} from '../products/variant-units';
import { assertTransition, OPEN_CART_STATUSES } from './sale-lifecycle';
import {
  approvalRequired,
  cartDiscountPercent,
  OverrideCheck,
  requiredOverrides,
} from './sale-authorization';
import { TaxResolverService } from './tax-resolver.service';
import { CustomerCreditService } from '../customers/credit/customer-credit.service';
import {
  IssuedGiftCard,
  StoredValueService,
} from '../stored-value/stored-value.service';
import {
  StoredValueAccount,
  StoredValueStatus,
  StoredValueType,
} from '../database/entities/stored-value-account.entity';
import { OutboxService } from '../platform/outbox/outbox.service';
import {
  EXCHANGE_CREDIT_CODE,
  GIFT_CARD_CODE,
  ON_ACCOUNT_CODE,
  returnedRows,
  SpecialTenderCode,
  specialTenderOf,
  STORE_CREDIT_CODE,
} from './special-tenders';
import {
  ensureGiftCardVariant,
  isGiftCardLineKey,
  withGiftCardLines,
} from './stored-value-lines';
import {
  changeIn,
  exchangeRate,
  toSaleCurrency,
} from '../currency/currency-math';
import { CLOCK_TOLERANCE_MS } from '../sync/offline-lease';
import {
  CreateSaleDto,
  HeldSalesQueryDto,
  HoldSaleDto,
  ListSalesQueryDto,
  QuoteSaleDto,
  SaleItemInput,
} from './sales.dto';
import { containsPattern } from '../common/utils/like';

interface PreparedSale {
  register: Register;
  branch: Branch;
  customer: Customer | null;
  discount: Discount | null;
  variants: Map<string, ProductVariant>;
  // Catalog price of each line (before a price override)
  catalogPrices: Map<string, number>;
  calc: CalcResult;
  // Store default rate (lines may have their own)
  taxRate: number;
  settings: StoreSettings;
  overrides: OverrideCheck;
  // Cart lines as sent (line notes, discount reasons); calc line key = index
  items: SaleItemInput[];
  // Discounts above the store limit, which need a written reason: line keys, cart
  reasonsNeeded: { lines: string[]; cart: boolean };
  // Gift cards sold on the sale (calc lines gc0, gc1, ...)
  giftCards: { amount: number; code: string | null }[];
  // Unit of each variant (measured items: kg, m, l) for receipts
  units: Map<string, VariantUnit>;
}

// A line of an offline sale that took more units than the location had (D018)
interface OversoldLine {
  variantId: string;
  sku: string;
  productName: string;
  quantity: number;
  // Units sold that were not in stock
  shortBy: number;
  availableAfter: number;
}

/** Services and other non-stock items never move or reserve stock */
const isStockTracked = (variant: ProductVariant) =>
  variant.product?.isStockTracked !== false;
// Sale lines remember it (sale_items.metadata), so voids / returns / completion of a
// pending sale follow what the sale did even if the product changed since
const lineTracksStock = (item: Pick<SaleItem, 'metadata'>) =>
  item.metadata?.stockTracked !== false;

interface ValidatedPayment {
  paymentMethodId: string;
  // In the sale currency
  amount: number;
  reference?: string;
  idempotencyKey?: string;
  method: PaymentMethod;
  // Set when paid in another currency
  tendered: { currencyCode: string; amount: number; rate: number } | null;
  // On account, gift card, store credit or exchange credit (see special-tenders.ts)
  special: SpecialTenderCode | null;
  giftCardCode?: string;
  // Gift card / store credit account the payment is taken from
  storedValueAccountId?: string | null;
}

/** Internal options of create() (not part of the API request) */
export interface SaleCreateOptions {
  // Replacement sale of an exchange: paid (in part) by the returned goods' value
  exchange?: { linkId: string; creditAmount: number; originalSaleId: string };
  // Offline sale uploaded by someone else (sync push / import): the cashier who
  // rang it up on the till. Recorded as the sale's cashier (and whose permissions
  // offline_price checks use); the uploader goes to metadata.uploadedBy.
  actingUser?: {
    id: string;
    permissions: Permission[];
    // Why the uploader was recorded instead of the till's cashier
    note?: string | null;
  };
  // Offline sale uploaded by the till that recorded it (sync push / import).
  // Only then are the offline fields of the request honoured (capture time,
  // offline number, device sequence, the till's exchange rates); POST /sales
  // refuses them.
  offline?: {
    // Till that recorded the sale (checked by the sync push)
    deviceId: string | null;
  };
}

// Offline sales may use the till's exchange rate only this close to the store's
const MAX_OFFLINE_RATE_DRIFT = 0.1;

// A payment taken offline at the till's exchange rate instead of the store's
interface OfflineRateUse {
  currencyCode: string;
  tillRate: number;
  storeRate: number;
  // Rate the payment was recorded at (the store's when the till's was too far off)
  appliedRate: number;
}

/** Result of the on-account checks made before the sale transaction */
interface OnAccountApproval {
  allowOverLimit: boolean;
  approverId: string | null;
}

// Change handed back in another currency than the sale's (stored on the sale)
export interface SaleChangeTender {
  currencyCode: string;
  amount: number;
  exchangeRate: number;
}

const SALE_REFERENCE = 'sale';
// How long a "being cancelled" flag blocks completion of a payment_pending sale
const CANCELLING_TIMEOUT_MS = 2 * 60_000;
const GIFT_CARD_UNUSABLE = "This gift card can't be used";
// Tenders that earn no loyalty points
const NO_LOYALTY_TENDERS = [
  LOYALTY_METHOD_CODE,
  GIFT_CARD_CODE,
  STORE_CREDIT_CODE,
  EXCHANGE_CREDIT_CODE,
  ON_ACCOUNT_CODE,
];
// A sale recorded without a shift can be voided this long after it was made
const VOID_WITHOUT_SHIFT_MS = 24 * 3_600_000;

// Sales history hides carts that never became sales, unless asked for by status
const HIDDEN_BY_DEFAULT = [
  SaleStatus.DRAFT,
  SaleStatus.HELD,
  SaleStatus.CANCELLED,
];

const OVERRIDE_MESSAGES: Partial<Record<Permission, (max: number) => string>> =
  {
    'pos.discount': () => 'You are not allowed to give discounts',
    'pos.discount.override': (max) =>
      `Discounts above ${max}% need a manager's approval`,
    'pos.price.override': () => "Changing a price needs a manager's approval",
  };

@Injectable()
export class SalesService implements OnModuleInit {
  private readonly logger = new Logger(SalesService.name);

  constructor(
    @InjectRepository(Sale)
    private saleRepository: Repository<Sale>,
    private settingsService: SettingsService,
    private pricingService: PricingService,
    private discountsService: DiscountsService,
    private inventoryService: InventoryService,
    private dataSource: DataSource,
    private auditService: AuditService,
    private approvalsService: ApprovalsService,
    private shiftsService: ShiftsService,
    private paymentsService: PaymentsService,
    private taxResolver: TaxResolverService,
    private loyaltyService: LoyaltyService,
    private estimatesService: EstimatesService,
    private customerCredit: CustomerCreditService,
    private storedValue: StoredValueService,
    @Optional() private outbox?: OutboxService,
  ) {}

  onModuleInit() {
    // Card payments captured later (webhook, lookup) complete the sale
    this.paymentsService.onSaleSettled((tenantId, saleId) =>
      this.completePendingSale(tenantId, saleId),
    );
  }

  /**
   * Price a cart without saving anything (used by the POS to show totals).
   * Discounts and price changes the user may not give are rejected here too.
   */
  async quote(
    tenantId: string,
    user: AuthUser,
    dto: QuoteSaleDto,
    approvalToken?: string,
  ) {
    const prepared = await this.prepare(tenantId, dto, false);
    this.checkPolicies(prepared, dto);
    await this.authorize(user, prepared, approvalToken);
    return this.toQuote(prepared);
  }

  /**
   * Complete a sale: prices, discounts, tax, payments and stock in one transaction.
   * With card payments through an asynchronous provider, the sale waits in
   * payment_pending (stock reserved) until every payment is captured.
   */
  async create(
    tenantId: string,
    user: AuthUser,
    dto: CreateSaleDto,
    approvalToken?: string,
    options: SaleCreateOptions = {},
  ): Promise<Sale & { issuedGiftCards?: IssuedGiftCard[] }> {
    const requestHash = SalesService.requestHash(dto);
    if (dto.idempotencyKey) {
      const existing = await this.saleRepository.findOne({
        where: { tenantId, idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        return this.replay(tenantId, existing, requestHash);
      }
    }

    const offline = !!options.offline;
    SalesService.assertOfflineFields(dto, offline);
    // Cashier of record: the till's cashier for an uploaded offline sale
    const cashier = options.actingUser ?? user;
    // The till the request comes from (online) or that recorded the sale (sync),
    // never a device id taken from the body
    const deviceId = options.offline
      ? options.offline.deviceId
      : (requestContext.get()?.deviceId ?? null);
    const revokedDevice = await this.checkDevice(tenantId, deviceId, dto);
    const prepared = await this.prepare(tenantId, dto, offline);
    const { register, branch, customer, discount, variants, calc, settings } =
      prepared;
    // Offline sales already happened: record them, but flag what was not approved
    if (!offline) this.checkPolicies(prepared, dto);
    const approvals = offline
      ? []
      : await this.authorize(user, prepared, approvalToken);
    const salespersonId = await this.resolveSalesperson(
      tenantId,
      dto.salespersonId,
      offline,
    );
    const shiftId = await this.resolveShift(
      tenantId,
      register.id,
      settings,
      offline ? new Date(dto.offlineCapturedAt!) : null,
    );
    // Offline, with no shift open then or now: its cash is in no drawer yet
    const noShift = offline && !shiftId;

    const payments = await this.validatePayments(tenantId, dto, calc.total, {
      saleCurrency: branch.currencyCode,
      settings,
      offline,
      exchange: options.exchange,
    });
    // Selling on account: the permission (or a manager's approval), the credit
    // hold and the limit (approval to exceed it); checked again atomically below
    const onAccount =
      payments.onAccountTotal > 0
        ? await this.authorizeOnAccount(
            tenantId,
            user,
            customer,
            payments.onAccountTotal,
            approvalToken,
          )
        : null;
    const isAsync = (p: ValidatedPayment) =>
      p.method.methodType !== PaymentMethodType.CASH &&
      this.paymentsService.providerOf(p.method).async;
    const deferred = !offline && payments.rows.some(isAsync);
    const target = deferred ? SaleStatus.PAYMENT_PENDING : SaleStatus.COMPLETED;

    let saleId: string;
    let issuedGiftCards: IssuedGiftCard[] = [];
    try {
      saleId = await this.dataSource.transaction(async (manager) => {
        const cart = dto.heldSaleId
          ? await this.lockOpenCart(manager, tenantId, dto.heldSaleId)
          : null;
        assertTransition(cart?.status ?? SaleStatus.DRAFT, target);
        // An estimate is sold once: locked until this sale commits, refused if
        // another sale converted it meanwhile
        if (dto.estimateId) {
          await this.estimatesService.lockOpen(
            manager,
            tenantId,
            dto.estimateId,
          );
        }

        // Completed: the branch's next number (D017). Waiting for a card: a
        // provisional P- number (a resumed cart keeps its H- number) until then.
        const saleNumber =
          target === SaleStatus.COMPLETED
            ? await this.branchNumber(manager, tenantId, branch)
            : (cart?.saleNumber ??
              (await this.nextNumber(manager, tenantId, 'P')));

        const fields: Partial<Sale> = {
          tenantId,
          saleNumber,
          branchId: branch.id,
          registerId: register.id,
          customerId: customer?.id,
          userId: cashier.id,
          saleType: options.exchange ? SaleType.EXCHANGE : SaleType.REGULAR,
          ...(options.exchange && {
            parentSaleId: options.exchange.originalSaleId,
          }),
          saleDate: dto.offlineCapturedAt
            ? new Date(dto.offlineCapturedAt)
            : new Date(),
          subtotal: calc.subtotal,
          taxAmount: calc.taxAmount,
          discountAmount: calc.discountAmount,
          total: calc.total,
          amountPaid: payments.amountPaid,
          changeAmount: payments.change,
          currencyCode: branch.currencyCode,
          notes:
            [dto.notes, offline ? 'Recorded offline' : null]
              .filter(Boolean)
              .join(' · ') || undefined,
          status: target,
          idempotencyKey: dto.idempotencyKey,
          shiftId,
          offlineNumber: dto.offlineNumber ?? null,
          deviceId,
          deviceSequence: dto.deviceSequence ?? null,
          heldUntil: null,
          salespersonId,
          // Frozen seller identity for receipts; a pending sale gets it on completion
          documentSnapshot:
            target === SaleStatus.COMPLETED
              ? buildDocumentSnapshot(settings, branch)
              : null,
          metadata: {
            ...(cart?.metadata ?? {}),
            cart: undefined,
            cartDiscountReason: dto.cartDiscount?.reason?.trim() || undefined,
            discountId: discount?.id ?? null,
            estimateId: dto.estimateId ?? null,
            changeTender: payments.changeTender,
            // Counted at checkout (also while waiting for a card); given back if cancelled
            discountConsumed: discount ? true : undefined,
            requestHash: dto.idempotencyKey ? requestHash : undefined,
            uploadedBy: options.actingUser ? user.id : undefined,
            cashierNote: options.actingUser?.note || undefined,
            // AC05: new prices shown and confirmed at the till before tendering
            repricing: dto.repricedConfirmedAt
              ? {
                  confirmedAt: dto.repricedConfirmedAt,
                  confirmedBy: cashier.id,
                  previousTotal: dto.repricedPreviousTotal ?? null,
                  total: calc.total,
                }
              : undefined,
          },
        };

        let sale: Sale;
        if (cart) {
          // The held cart becomes this sale: its reservation and old lines go
          await this.releaseStock(manager, tenantId, cart.id);
          await manager.delete(SaleItem, { tenantId, saleId: cart.id });
          sale = await manager.save(Object.assign(cart, fields));
        } else {
          sale = await manager.save(manager.create(Sale, fields));
        }

        // Take a use of the code now, also for a sale waiting for its card: two
        // registers cannot both take the last use (given back if cancelled)
        if (discount) {
          await this.consumeDiscount(manager, discount, {
            customerId: customer?.id ?? null,
            saleId: sale.id,
          });
        }

        const costs = new Map<string, number>();
        const oversold: OversoldLine[] = [];
        for (const line of calc.lines) {
          const variant = variants.get(line.key)!;
          if (!isStockTracked(variant)) continue;
          if (target === SaleStatus.COMPLETED) {
            // Take the items out of the register's stock location
            const applied = await this.inventoryService.applyMovement(manager, {
              tenantId,
              userId: user.id,
              variantId: variant.id,
              locationId: register.defaultLocationId,
              delta: -line.quantity,
              movementType: MovementType.SALE,
              referenceType: SALE_REFERENCE,
              referenceId: sale.id,
              referenceNumber: saleNumber,
              // Stock never goes negative at the till (D018). Offline sales already
              // happened (the goods were handed over): recorded anyway, and any
              // shortfall opens a review case below.
              allowOversell: offline,
            });
            costs.set(line.key, applied.unitCost);
            // Checked on the level locked by the movement, so concurrent syncs agree
            const availableAfter = subQty(
              Number(applied.quantityOnHand),
              Number(applied.quantityReserved),
            );
            if (offline && availableAfter < 0) {
              oversold.push({
                variantId: variant.id,
                sku: variant.sku,
                productName: variant.product.name?.en ?? variant.sku,
                quantity: line.quantity,
                shortBy: Math.min(line.quantity, -availableAfter),
                availableAfter,
              });
            }
          } else {
            await this.inventoryService.reserve(manager, {
              tenantId,
              variantId: variant.id,
              locationId: register.defaultLocationId,
              quantity: line.quantity,
              referenceType: SALE_REFERENCE,
              referenceId: sale.id,
              // No expiry: whether the card was charged is up to the provider;
              // the stock is freed when the sale is completed or cancelled
              expiresAt: null,
            });
          }
        }

        const savedItems: SaleItem[] = await manager.save(
          this.itemRows(manager, tenantId, sale.id, prepared, costs),
        );

        const savedPayments: Payment[] = await manager.save(
          payments.rows.map((payment, index) => {
            const async = deferred && isAsync(payment);
            const cash = payment.method.methodType === PaymentMethodType.CASH;
            return manager.create(Payment, {
              tenantId,
              saleId: sale.id,
              paymentMethodId: payment.paymentMethodId,
              amount: payment.amount,
              currencyCode: branch.currencyCode,
              tenderedCurrency: payment.tendered?.currencyCode ?? null,
              tenderedAmount: payment.tendered?.amount ?? null,
              exchangeRate: payment.tendered?.rate ?? null,
              reference: payment.reference,
              provider: cash
                ? null
                : this.paymentsService.providerOf(payment.method).name,
              status: async ? PaymentStatus.INITIATED : PaymentStatus.COMPLETED,
              capturedAt: async ? null : new Date(),
              idempotencyKey: async
                ? (payment.idempotencyKey ??
                  PaymentsService.attemptKey(dto.idempotencyKey, index))
                : undefined,
              ...(payment.storedValueAccountId && {
                metadata: {
                  storedValueAccountId: payment.storedValueAccountId,
                },
              }),
            });
          }),
        );

        // Spend the points now (also for sales waiting on a card: undone if cancelled)
        const pointsPaid = round2(
          payments.rows
            .filter((p) => this.loyaltyService.isLoyaltyMethod(p.method))
            .reduce((sum, p) => sum + p.amount, 0),
        );
        if (pointsPaid > 0 && customer) {
          await this.loyaltyService.redeem(manager, {
            tenantId,
            customerId: customer.id,
            saleId: sale.id,
            amount: pointsPaid,
          });
        }

        // Gift cards / store credit spent, the charge on account, the exchange credit
        // (also for sales waiting on a card: all undone if the sale is cancelled)
        await this.postSpecialTenders(manager, {
          tenantId,
          sale,
          customerId: customer?.id ?? null,
          rows: payments.rows,
          saved: savedPayments,
          onAccountTotal: payments.onAccountTotal,
          onAccount,
          exchange: options.exchange,
        });

        // Gift cards sold: active now, or once the card payment is captured
        if (prepared.giftCards.length) {
          issuedGiftCards = await this.storedValue.createSaleGiftCards(
            manager,
            {
              tenantId,
              saleId: sale.id,
              currencyCode: branch.currencyCode,
              activate: target === SaleStatus.COMPLETED,
              cards: prepared.giftCards.map((card, index) => ({
                amount: card.amount,
                code: card.code,
                saleItemId:
                  savedItems.find(
                    (item) => item.metadata?.giftCardIndex === index,
                  )?.id ?? null,
              })),
            },
          );
        }

        if (oversold.length > 0) {
          await openConflictCase(manager, {
            tenantId,
            type: ConflictCaseType.OFFLINE_OVERSELL,
            saleId: sale.id,
            deviceId,
            details: {
              saleNumber,
              offlineNumber: dto.offlineNumber ?? null,
              offlineCapturedAt: dto.offlineCapturedAt,
              registerId: register.id,
              locationId: register.defaultLocationId,
              lines: oversold,
            },
          });
        }
        // Offline, nobody could approve: discounts / prices the cashier may not
        // give, and payments taken at the till's exchange rate instead of the store's
        const unapproved = offline
          ? prepared.overrides.permissions.filter(
              (p) => !cashier.permissions?.includes(p),
            )
          : [];
        if (unapproved.length > 0 || payments.offlineRates.length > 0) {
          await openConflictCase(manager, {
            tenantId,
            type: ConflictCaseType.OFFLINE_PRICE,
            saleId: sale.id,
            deviceId,
            details: {
              saleNumber,
              offlineNumber: dto.offlineNumber ?? null,
              cashierId: cashier.id,
              ...(options.actingUser && { uploadedBy: user.id }),
              missingPermissions: unapproved,
              reasons: [
                ...(unapproved.length ? prepared.overrides.reasons : []),
                ...payments.offlineRates.map(
                  (r) =>
                    `${r.currencyCode} taken at the till's rate ${r.tillRate} (store rate ${r.storeRate}; recorded at ${r.appliedRate})`,
                ),
              ],
              discountAmount: calc.discountAmount,
              exchangeRates: payments.offlineRates,
            },
          });
        }
        if (noShift) {
          // Cash taken with no shift open (then or now): in no drawer's count
          await openConflictCase(manager, {
            tenantId,
            type: ConflictCaseType.OFFLINE_NO_SHIFT,
            saleId: sale.id,
            deviceId,
            details: {
              saleNumber,
              offlineNumber: dto.offlineNumber ?? null,
              offlineCapturedAt: dto.offlineCapturedAt,
              registerId: register.id,
              total: calc.total,
              cashPaid: round2(
                payments.rows
                  .filter((p) => p.method.methodType === PaymentMethodType.CASH)
                  .reduce((sum, p) => sum + p.amount, 0),
              ),
              changeAmount: payments.change,
            },
          });
        }

        if (target === SaleStatus.COMPLETED) {
          if (dto.estimateId) {
            await this.estimatesService.markConverted(
              manager,
              tenantId,
              dto.estimateId,
              sale.id,
            );
          }
          await this.awardLoyalty(
            manager,
            tenantId,
            customer?.id,
            sale.id,
            calc.total,
            sale.saleDate,
          );
          await this.emitCompleted(manager, sale, register.defaultLocationId, [
            ...savedItems,
          ]);
        }

        if (revokedDevice) {
          // Rung up offline before the till was revoked: accepted, but on record
          await this.auditService.record(
            {
              tenantId,
              action: 'sale.revoked_device_accepted',
              entityType: 'sale',
              entityId: sale.id,
              metadata: {
                saleNumber,
                deviceId,
                revokedAt: revokedDevice.revokedAt,
                offlineCapturedAt: dto.offlineCapturedAt,
                offlineNumber: dto.offlineNumber ?? null,
              },
            },
            manager,
          );
        }
        await this.auditOverrides(
          manager,
          tenantId,
          sale,
          prepared,
          approvals,
          offline,
        );
        if (dto.repricedConfirmedAt) {
          // AC05: informed confirmation of a repriced (resumed / stale) cart
          await this.auditService.record(
            {
              tenantId,
              action: 'sale.repricing_confirmed',
              entityType: 'sale',
              entityId: sale.id,
              metadata: {
                saleNumber,
                confirmedAt: dto.repricedConfirmedAt,
                previousTotal: dto.repricedPreviousTotal ?? null,
                total: calc.total,
                heldSaleId: dto.heldSaleId ?? null,
                offline,
              },
            },
            manager,
          );
        }
        return sale.id;
      });
    } catch (error) {
      // Two submissions with the same key raced: return the one that won
      if (
        dto.idempotencyKey &&
        isPgError(error, PG_UNIQUE_VIOLATION, 'uq_sale_idempotency')
      ) {
        const existing = await this.saleRepository.findOneOrFail({
          where: { tenantId, idempotencyKey: dto.idempotencyKey },
        });
        return this.replay(tenantId, existing, requestHash);
      }
      throw error;
    }

    if (deferred) {
      // Outside the transaction: provider calls can be slow
      await this.paymentsService
        .startPayments(tenantId, saleId)
        .catch((error: Error) =>
          this.logger.error(
            `Starting payments of ${saleId} failed: ${error.message}`,
          ),
        );
    }
    const result = await this.findOne(tenantId, saleId);
    // The full gift card codes are shown once, in this response only
    return issuedGiftCards.length
      ? Object.assign(result, { issuedGiftCards })
      : result;
  }

  /**
   * Called when every payment of a payment_pending sale is captured:
   * number it, commit the reserved stock and apply discount usage and loyalty points
   */
  async completePendingSale(tenantId: string, saleId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const sale = await manager.findOne(Sale, {
        where: { id: saleId, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      // Already completed by a concurrent webhook/lookup, or cancelled
      if (!sale || sale.status !== SaleStatus.PAYMENT_PENDING) return;
      // Being cancelled at the till (a stale flag from a crashed cancel expires)
      const cancellingAt = sale.metadata?.cancellingAt as string | undefined;
      if (
        cancellingAt &&
        Date.now() - new Date(cancellingAt).getTime() < CANCELLING_TIMEOUT_MS
      ) {
        return;
      }
      const payments = await manager.find(Payment, {
        where: { tenantId, saleId },
      });
      if (summarizePayments(payments.map((p) => p.status)) !== 'settled') {
        return;
      }
      assertTransition(sale.status, SaleStatus.COMPLETED);

      const register = await manager.findOneOrFail(Register, {
        where: { id: sale.registerId, tenantId },
      });
      const branch = await manager.findOneOrFail(Branch, {
        where: { id: sale.branchId, tenantId },
      });
      const settings = await this.settingsService.getSettings(tenantId);
      const provisionalNumber = sale.saleNumber;
      const saleNumber = await this.branchNumber(manager, tenantId, branch);

      await this.releaseStock(manager, tenantId, sale.id, true);
      const items = await manager.find(SaleItem, {
        where: { tenantId, saleId },
        order: { lineNumber: 'ASC' },
      });
      for (const item of items) {
        if (!lineTracksStock(item)) continue;
        const applied = await this.inventoryService.applyMovement(manager, {
          tenantId,
          userId: sale.userId,
          variantId: item.variantId,
          locationId: register.defaultLocationId,
          delta: -item.quantity,
          movementType: MovementType.SALE,
          referenceType: SALE_REFERENCE,
          referenceId: sale.id,
          referenceNumber: saleNumber,
          // The card is already charged and the goods were reserved for this sale:
          // posting must not fail (an unexpected shortfall is caught by reconciliation)
          allowOversell: true,
        });
        await manager.update(
          SaleItem,
          { id: item.id },
          { cost: applied.unitCost },
        );
      }

      const estimateId = sale.metadata?.estimateId as string | null | undefined;
      if (estimateId) {
        // The card is charged: a conversion lost to another sale is only recorded
        await this.estimatesService.markConverted(
          manager,
          tenantId,
          estimateId,
          sale.id,
          { strict: false },
        );
      }

      // Counted at checkout; sales started before that was done count it now,
      // even past the limit (the card is already charged)
      const discountId = sale.metadata?.discountId as string | null | undefined;
      if (discountId && !sale.metadata?.discountConsumed) {
        await manager.query(
          `UPDATE discounts SET "usageCount" = "usageCount" + 1, updated_at = NOW()
            WHERE id = $1 AND "tenantId" = $2`,
          [discountId, tenantId],
        );
      }
      const completedAt = new Date();
      await this.awardLoyalty(
        manager,
        tenantId,
        sale.customerId,
        sale.id,
        Number(sale.total),
        completedAt,
      );
      // Gift cards sold on the sale get their value now that it is paid
      await this.storedValue.activateSaleGiftCards(manager, tenantId, sale.id);

      await manager.update(
        Sale,
        { id: sale.id, tenantId },
        {
          status: SaleStatus.COMPLETED,
          saleNumber,
          saleDate: completedAt,
          documentSnapshot: buildDocumentSnapshot(
            settings,
            branch,
            completedAt,
          ),
        },
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'sale.payment_completed',
          entityType: 'sale',
          entityId: sale.id,
          metadata: { saleNumber, provisionalNumber, total: sale.total },
        },
        manager,
      );
      await this.emitCompleted(
        manager,
        { ...sale, saleNumber },
        register.defaultLocationId,
        items,
      );
    });
  }

  // ---------------------------------------------------------------------------
  // Held carts (R042)

  /**
   * Park a cart: saved as a held sale with its stock reserved until it expires
   */
  async hold(
    tenantId: string,
    user: AuthUser,
    dto: HoldSaleDto,
  ): Promise<Sale> {
    if (dto.giftCards?.length) {
      throw new BadRequestException(
        'Gift cards are sold at checkout and cannot be held',
      );
    }
    const prepared = await this.prepare(tenantId, dto, false);
    const { register, branch, customer, calc, variants, settings } = prepared;
    const salespersonId = await this.resolveSalesperson(
      tenantId,
      dto.salespersonId,
      false,
    );
    const heldUntil = new Date(
      Date.now() + settings.heldCartExpiryHours * 3_600_000,
    );

    const saleId = await this.dataSource.transaction(async (manager) => {
      const existing = dto.heldSaleId
        ? await this.lockOpenCart(manager, tenantId, dto.heldSaleId)
        : null;
      assertTransition(existing?.status ?? SaleStatus.DRAFT, SaleStatus.HELD);

      const fields: Partial<Sale> = {
        tenantId,
        saleNumber:
          existing?.saleNumber ??
          (await this.nextNumber(manager, tenantId, 'H')),
        branchId: branch.id,
        registerId: register.id,
        customerId: customer?.id ?? (null as unknown as string),
        userId: user.id,
        saleType: SaleType.REGULAR,
        saleDate: new Date(),
        subtotal: calc.subtotal,
        taxAmount: calc.taxAmount,
        discountAmount: calc.discountAmount,
        total: calc.total,
        amountPaid: 0,
        changeAmount: 0,
        currencyCode: branch.currencyCode,
        notes: dto.notes ?? (null as unknown as string),
        status: SaleStatus.HELD,
        heldUntil,
        heldLabel: dto.label ?? null,
        salespersonId,
        metadata: {
          cart: {
            priceListId: dto.priceListId ?? null,
            discountCode: dto.discountCode ?? null,
            cartDiscount: dto.cartDiscount ?? null,
          },
        },
      };
      let sale: Sale;
      if (existing) {
        await this.releaseStock(manager, tenantId, existing.id);
        await manager.delete(SaleItem, { tenantId, saleId: existing.id });
        sale = await manager.save(Object.assign(existing, fields));
      } else {
        sale = await manager.save(manager.create(Sale, fields));
      }

      await manager.save(
        this.itemRows(manager, tenantId, sale.id, prepared, new Map()),
      );
      // A held cart never fails for lack of stock; it just makes the units unavailable
      for (const line of calc.lines) {
        if (!isStockTracked(variants.get(line.key)!)) continue;
        await this.inventoryService.reserve(manager, {
          tenantId,
          variantId: variants.get(line.key)!.id,
          locationId: register.defaultLocationId,
          quantity: line.quantity,
          referenceType: SALE_REFERENCE,
          referenceId: sale.id,
          expiresAt: heldUntil,
        });
      }

      await this.auditService.record(
        {
          tenantId,
          action: 'sale.held',
          entityType: 'sale',
          entityId: sale.id,
          metadata: {
            saleNumber: sale.saleNumber,
            total: calc.total,
            heldUntil,
            lines: calc.lines.length,
          },
        },
        manager,
      );
      return sale.id;
    });
    return this.findOne(tenantId, saleId);
  }

  /**
   * Held carts that have not expired, newest first
   */
  async listHeld(tenantId: string, query: HeldSalesQueryDto): Promise<Sale[]> {
    await this.expireHeldCarts(tenantId);
    const qb = this.saleRepository
      .createQueryBuilder('sale')
      .leftJoinAndSelect('sale.items', 'items')
      .leftJoinAndSelect('sale.customer', 'customer')
      .leftJoin('sale.register', 'register')
      .addSelect(['register.id', 'register.name', 'register.code'])
      .leftJoin('sale.user', 'user')
      .addSelect(['user.id', 'user.firstName', 'user.lastName', 'user.email'])
      .where('sale.tenantId = :tenantId AND sale.status = :held', {
        tenantId,
        held: SaleStatus.HELD,
      })
      .orderBy('sale.saleDate', 'DESC')
      .addOrderBy('items.lineNumber', 'ASC');
    if (query.registerId) {
      qb.andWhere('sale.registerId = :registerId', {
        registerId: query.registerId,
      });
    }
    if (query.branchId) {
      qb.andWhere('sale.branchId = :branchId', { branchId: query.branchId });
    }
    const scope = branchFilterSql('sale');
    if (scope) qb.andWhere(scope.sql, scope.params);
    return qb.getMany();
  }

  /**
   * Take a held cart back to a till. It becomes a draft (still reserved) that the
   * POS loads into its cart; checking out with heldSaleId turns it into the sale.
   */
  async resume(tenantId: string, id: string) {
    const settings = await this.settingsService.getSettings(tenantId);
    const expired = await this.dataSource.transaction(async (manager) => {
      const sale = await manager.findOne(Sale, {
        where: { id, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!sale || !canAccessBranch(sale.branchId)) {
        throw new NotFoundException('Held cart not found');
      }
      if (sale.status !== SaleStatus.HELD) {
        throw new ConflictException(
          sale.status === SaleStatus.CANCELLED
            ? 'This held cart was cancelled or has expired'
            : 'This cart is not on hold (it may already be open at another till)',
        );
      }
      if (sale.heldUntil && new Date(sale.heldUntil) < new Date()) {
        await this.cancelCart(manager, sale, 'Hold expired', true);
        return true;
      }
      assertTransition(sale.status, SaleStatus.DRAFT);

      // Renew the reservation for the time the cart is open at the till
      const heldUntil = new Date(
        Date.now() + settings.heldCartExpiryHours * 3_600_000,
      );
      const register = await manager.findOneOrFail(Register, {
        where: { id: sale.registerId, tenantId },
      });
      const items = await manager.find(SaleItem, {
        where: { tenantId, saleId: id },
      });
      await this.releaseStock(manager, tenantId, id);
      for (const item of items) {
        if (!lineTracksStock(item)) continue;
        await this.inventoryService.reserve(manager, {
          tenantId,
          variantId: item.variantId,
          locationId: register.defaultLocationId,
          quantity: item.quantity,
          referenceType: SALE_REFERENCE,
          referenceId: id,
          expiresAt: heldUntil,
        });
      }
      await manager.update(
        Sale,
        { id, tenantId },
        { status: SaleStatus.DRAFT, heldUntil },
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'sale.resumed',
          entityType: 'sale',
          entityId: id,
          metadata: { saleNumber: sale.saleNumber },
        },
        manager,
      );
      return false;
    });
    if (expired) {
      throw new ConflictException('This held cart has expired');
    }
    const sale = await this.findOne(tenantId, id);
    return { sale, cart: await this.toCart(tenantId, sale) };
  }

  /**
   * Cancel a cart that never became a sale: a held/resumed cart, or a sale still
   * waiting for its card payment (open payments are cancelled, captured ones refunded)
   */
  async cancel(tenantId: string, id: string, reason?: string): Promise<Sale> {
    const sale = await this.findOne(tenantId, id);
    assertTransition(sale.status, SaleStatus.CANCELLED);
    if (sale.status === SaleStatus.PAYMENT_PENDING) {
      // Block completion first: a capture arriving while we cancel must not
      // complete a sale whose payment is being refunded
      if (!(await this.markCancelling(tenantId, id, true))) {
        throw new ConflictException(
          'This sale was completed in the meantime; void it instead',
        );
      }
      const stopped = await this.paymentsService
        .cancelSalePayments(tenantId, id)
        .catch(() => false);
      if (!stopped) {
        await this.markCancelling(tenantId, id, false);
        // Whatever was captured stays captured: let the sale complete if it can
        await this.completePendingSale(tenantId, id);
        throw new ConflictException(
          'A card payment could not be cancelled or refunded. Check it at the terminal, then try again.',
        );
      }
    }
    await this.dataSource.transaction(async (manager) => {
      const locked = await manager.findOne(Sale, {
        where: { id, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!locked) throw new NotFoundException('Sale not found');
      assertTransition(locked.status, SaleStatus.CANCELLED);
      await this.cancelCart(
        manager,
        locked,
        reason ?? 'Cancelled at the till',
        false,
      );
    });
    return this.findOne(tenantId, id);
  }

  /**
   * Flag a payment_pending sale as being cancelled (completion skips it), or clear
   * the flag. Returns false if the sale is no longer waiting for payment.
   */
  private async markCancelling(
    tenantId: string,
    id: string,
    on: boolean,
  ): Promise<boolean> {
    const result = await this.dataSource.query<unknown[]>(
      on
        ? `UPDATE sales SET metadata = metadata || jsonb_build_object('cancellingAt', NOW())
           WHERE id = $1 AND "tenantId" = $2 AND status = 'payment_pending' RETURNING id`
        : `UPDATE sales SET metadata = metadata - 'cancellingAt'
           WHERE id = $1 AND "tenantId" = $2 RETURNING id`,
      [id, tenantId],
    );
    // TypeORM returns [rows, affected] for UPDATE ... RETURNING on Postgres
    const rows = Array.isArray(result[0]) ? result[0] : result;
    return rows.length > 0;
  }

  // ---------------------------------------------------------------------------
  // Receipts (R112/R113)

  /**
   * Count a receipt reprint. The first print is the original; every later print
   * is a "COPY" and is counted and audited.
   */
  async reprint(tenantId: string, id: string) {
    const sale = await this.saleRepository.findOne({ where: { id, tenantId } });
    if (!sale || !canAccessBranch(sale.branchId)) {
      throw new NotFoundException('Sale not found');
    }
    if (
      [
        ...OPEN_CART_STATUSES,
        SaleStatus.PAYMENT_PENDING,
        SaleStatus.CANCELLED,
      ].includes(sale.status)
    ) {
      throw new ConflictException(
        'Only finished sales have a receipt to reprint',
      );
    }
    const receiptPrintCount = await this.dataSource.transaction(
      async (manager) => {
        const rows = await manager.query<{ receiptPrintCount: number }[]>(
          `UPDATE sales SET "receiptPrintCount" = "receiptPrintCount" + 1
         WHERE id = $1 AND "tenantId" = $2 RETURNING "receiptPrintCount"`,
          [id, tenantId],
        );
        // node-postgres returns [rows, count] for UPDATE ... RETURNING through TypeORM
        const updated = (Array.isArray(rows[0]) ? rows[0] : rows) as {
          receiptPrintCount: number;
        }[];
        const count =
          updated[0]?.receiptPrintCount ?? sale.receiptPrintCount + 1;
        await this.auditService.record(
          {
            tenantId,
            action: 'sale.receipt_reprinted',
            entityType: 'sale',
            entityId: id,
            metadata: { saleNumber: sale.saleNumber, copyNumber: count },
          },
          manager,
        );
        return count;
      },
    );
    return { id, saleNumber: sale.saleNumber, receiptPrintCount };
  }

  // ---------------------------------------------------------------------------
  // History

  async findAll(
    tenantId: string,
    query: ListSalesQueryDto,
  ): Promise<PaginatedResult<Sale>> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;

    const qb = this.saleRepository
      .createQueryBuilder('sale')
      .leftJoinAndSelect('sale.customer', 'customer')
      .leftJoin('sale.user', 'user')
      .addSelect(['user.id', 'user.firstName', 'user.lastName', 'user.email'])
      .leftJoin('sale.salesperson', 'salesperson')
      .addSelect([
        'salesperson.id',
        'salesperson.firstName',
        'salesperson.lastName',
        'salesperson.email',
      ])
      .where('sale.tenantId = :tenantId', { tenantId })
      .orderBy('sale.saleDate', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);

    if (query.from) {
      qb.andWhere('sale.saleDate >= :from', { from: query.from });
    }
    if (query.to) {
      qb.andWhere('sale.saleDate <= :to', { to: query.to });
    }
    if (query.status) {
      qb.andWhere('sale.status = :status', { status: query.status });
    } else {
      qb.andWhere('sale.status NOT IN (:...hidden)', {
        hidden: HIDDEN_BY_DEFAULT,
      });
    }
    if (query.customerId) {
      qb.andWhere('sale.customerId = :customerId', {
        customerId: query.customerId,
      });
    }
    if (query.registerId) {
      qb.andWhere('sale.registerId = :registerId', {
        registerId: query.registerId,
      });
    }
    if (query.salespersonId) {
      qb.andWhere('sale.salespersonId = :salespersonId', {
        salespersonId: query.salespersonId,
      });
    }
    if (query.search) {
      // Final number or the provisional OFFLINE-… number printed on the receipt
      qb.andWhere(
        '(sale.saleNumber ILIKE :search OR sale.offlineNumber ILIKE :search)',
        { search: containsPattern(query.search) },
      );
    }
    // Only the sales of the user's branches (spec §9)
    const scope = branchFilterSql('sale');
    if (scope) qb.andWhere(scope.sql, scope.params);

    const [data, total] = await qb.getManyAndCount();
    return paginate(data, total, page, limit);
  }

  /**
   * Full sale with lines, payments and people — everything a receipt needs
   */
  async findOne(tenantId: string, id: string): Promise<Sale> {
    const sale = await this.saleRepository
      .createQueryBuilder('sale')
      .leftJoinAndSelect('sale.items', 'items')
      .leftJoinAndSelect('sale.payments', 'payments')
      .leftJoinAndSelect('payments.paymentMethod', 'paymentMethod')
      .leftJoinAndSelect('sale.customer', 'customer')
      .leftJoinAndSelect('sale.register', 'register')
      .leftJoinAndSelect('sale.branch', 'branch')
      .leftJoin('sale.user', 'user')
      .addSelect(['user.id', 'user.firstName', 'user.lastName', 'user.email'])
      .leftJoin('sale.salesperson', 'salesperson')
      .addSelect([
        'salesperson.id',
        'salesperson.firstName',
        'salesperson.lastName',
        'salesperson.email',
      ])
      .where('sale.id = :id AND sale.tenantId = :tenantId', { id, tenantId })
      .orderBy('items.lineNumber', 'ASC')
      .getOne();

    // Another branch's sale is "not found" for a branch-limited user (spec §17)
    if (!sale || !canAccessBranch(sale.branchId)) {
      throw new NotFoundException('Sale not found');
    }
    return sale;
  }

  /**
   * Cancel a completed sale: puts the stock back and reverses loyalty points
   */
  async void(
    tenantId: string,
    user: User,
    id: string,
    reason: string,
  ): Promise<Sale> {
    const sale = await this.findOne(tenantId, id);
    assertTransition(sale.status, SaleStatus.VOIDED);
    await this.assertVoidable(tenantId, sale);
    const register = await this.dataSource
      .getRepository(Register)
      .findOneOrFail({ where: { id: sale.registerId, tenantId } });

    await this.dataSource.transaction(async (manager) => {
      // Same lock as returns: a return and a void of one sale never interleave
      await manager.findOne(Sale, {
        where: { id, tenantId },
        lock: { mode: 'pessimistic_write' },
      });
      // Anything already given back (return, exchange, goodwill refund) would be
      // refunded twice by a void
      const [returned] = await manager.query<{ id: string }[]>(
        `SELECT id FROM sale_returns WHERE "tenantId" = $1 AND "originalSaleId" = $2 LIMIT 1`,
        [tenantId, id],
      );
      if (returned) {
        throw new ConflictException(
          'This sale already has a return or refund: use a return instead of a void',
        );
      }
      const updated = await manager.update(
        Sale,
        { id, tenantId, status: SaleStatus.COMPLETED },
        {
          status: SaleStatus.VOIDED,
          notes: [sale.notes, `Voided: ${reason}`].filter(Boolean).join(' · '),
        },
      );
      if (!updated.affected) {
        throw new ConflictException('Sale was already voided');
      }

      await this.auditService.record(
        {
          tenantId,
          action: 'sale.voided',
          entityType: 'sale',
          entityId: sale.id,
          reason,
          metadata: { saleNumber: sale.saleNumber, total: sale.total },
        },
        manager,
      );

      await manager.update(
        Payment,
        { saleId: id, tenantId },
        { status: PaymentStatus.REFUNDED },
      );

      for (const item of sale.items) {
        if (!lineTracksStock(item)) continue;
        await this.inventoryService.applyMovement(manager, {
          tenantId,
          userId: user.id,
          variantId: item.variantId,
          locationId: register.defaultLocationId,
          delta: item.quantity,
          movementType: MovementType.RETURN,
          referenceType: SALE_REFERENCE,
          referenceId: sale.id,
          referenceNumber: sale.saleNumber,
          cost: item.cost ?? undefined,
          notes: `Void: ${reason}`,
        });
      }

      // Earned points taken back, spent points given back
      await this.loyaltyService.reverseSale(
        manager,
        tenantId,
        sale.id,
        `Void ${sale.saleNumber}`,
      );
      // Account charge reversed, gift cards / store credit spent given back, and
      // gift cards sold on the sale cancelled (refused if one was already used)
      await this.reverseStoredValueAndCredit(
        manager,
        tenantId,
        sale.id,
        `Void ${sale.saleNumber}`,
      );
      await this.outbox?.record(manager, {
        tenantId,
        type: 'sale.voided',
        aggregateId: sale.id,
        aggregateVersion: sale.version ?? null,
        payload: { saleId: sale.id, saleNumber: sale.saleNumber, reason },
      });
    });

    return this.findOne(tenantId, id);
  }

  /**
   * A void undoes a sale as if it never happened, so only while its drawer is
   * still open (a sale with no shift: within a day) and only when every payment
   * can be marked refunded here: card payments captured through a provider must
   * be refunded at the provider, with a return.
   */
  private async assertVoidable(tenantId: string, sale: Sale) {
    if (sale.shiftId) {
      const shift = await this.dataSource
        .getRepository(Shift)
        .findOne({ where: { id: sale.shiftId, tenantId } });
      if (shift && (shift.closedAt || shift.status === ShiftStatus.CLOSED)) {
        throw new ConflictException(
          "This sale's shift is closed: use a return instead of a void",
        );
      }
    } else if (
      Date.now() - new Date(sale.saleDate).getTime() >
      VOID_WITHOUT_SHIFT_MS
    ) {
      throw new ConflictException(
        'This sale is more than a day old: use a return instead of a void',
      );
    }
    const providerPaid = (sale.payments ?? []).some(
      (p) =>
        [
          PaymentStatus.AUTHORIZED,
          PaymentStatus.CAPTURED,
          PaymentStatus.COMPLETED,
        ].includes(p.status) &&
        !!p.provider &&
        p.provider !== 'manual',
    );
    if (providerPaid) {
      throw new ConflictException(
        'This sale was paid by card through a payment terminal: use a return to refund it',
      );
    }
  }

  // ---------------------------------------------------------------------------

  /**
   * Load and validate everything a sale depends on, then price the cart
   */
  private async prepare(
    tenantId: string,
    dto: QuoteSaleDto & { offlineCapturedAt?: string },
    offline: boolean,
  ): Promise<PreparedSale> {
    const register = await this.dataSource.getRepository(Register).findOne({
      where: { id: dto.registerId, tenantId },
    });
    if (!register || register.status !== RegisterStatus.ACTIVE) {
      throw new BadRequestException('Register not found or inactive');
    }
    // Only at a till of the user's branches (spec §9, AC15)
    assertBranchAccess(null, register.branchId, 'Register not found');
    if (!register.defaultLocationId) {
      throw new BadRequestException(
        'This register has no stock location. Set one in Settings.',
      );
    }
    const branch = await this.dataSource
      .getRepository(Branch)
      .findOneOrFail({ where: { id: register.branchId, tenantId } });

    let customer: Customer | null = null;
    if (dto.customerId) {
      customer = await this.dataSource.getRepository(Customer).findOne({
        where: { id: dto.customerId, tenantId },
      });
      if (!customer) {
        throw new NotFoundException('Customer not found');
      }
      if (customer.status === CustomerStatus.BLOCKED) {
        throw new BadRequestException('This customer is blocked');
      }
    }

    const giftCards = (dto.giftCards ?? []).map((card) => ({
      amount: round2(card.amount),
      code: card.code?.trim() || null,
    }));
    if (dto.items.length === 0 && giftCards.length === 0) {
      throw new BadRequestException('The cart is empty');
    }
    if (giftCards.length && offline) {
      throw new BadRequestException('Gift cards can only be sold online');
    }
    const codes = giftCards
      .map((c) => c.code?.toUpperCase().replace(/[^A-Z0-9]/g, ''))
      .filter(Boolean);
    if (new Set(codes).size !== codes.length) {
      throw new BadRequestException('The same gift card is in the cart twice');
    }

    const variantIds = [...new Set(dto.items.map((i) => i.variantId))];
    const variantList = variantIds.length
      ? await this.dataSource.getRepository(ProductVariant).find({
          where: { tenantId, id: In(variantIds) },
          relations: VARIANT_UNIT_RELATIONS,
        })
      : [];
    if (variantList.length !== variantIds.length) {
      throw new NotFoundException('One or more products were not found');
    }
    for (const variant of variantList) {
      const sellable =
        variant.status === VariantStatus.ACTIVE &&
        variant.product.status === ProductStatus.ACTIVE;
      // Offline sales were valid when rung up; don't reject them on sync
      if (!sellable && !offline) {
        throw new BadRequestException(
          `${variant.product.name?.en ?? variant.sku} is not available for sale`,
        );
      }
    }
    const byId = new Map(variantList.map((v) => [v.id, v]));
    // Decimal quantities only for measured items, up to their unit's precision
    // (offline sales were valid when rung up: not re-checked)
    const units = new Map(variantList.map((v) => [v.id, unitOfVariant(v)]));
    if (!offline) assertQuantitiesFit(units, dto.items);

    // Offline sales are priced as of when they were rung up
    const pricedAt =
      offline && dto.offlineCapturedAt
        ? new Date(dto.offlineCapturedAt)
        : undefined;
    const prices = await this.pricingService.resolvePrices(
      tenantId,
      variantList,
      { branchId: branch.id, priceListId: dto.priceListId, at: pricedAt },
    );
    // A chosen list that is not for everyone (wholesale, staff, ...) and not the
    // customer's group list: its prices are price changes (pos.price.override)
    const restrictedList =
      !!dto.priceListId &&
      (await this.pricingService.needsPriceOverride(
        tenantId,
        dto.priceListId,
        customer?.groupId ?? null,
      ));
    const catalog = restrictedList
      ? await this.pricingService.resolvePrices(tenantId, variantList, {
          branchId: branch.id,
          at: pricedAt,
        })
      : prices;

    const discount = dto.discountCode
      ? await this.discountsService.findUsableByCode(tenantId, dto.discountCode)
      : null;
    if (discount) {
      // Early answer for the till; checked again under lock when the use is taken
      await this.checkCustomerDiscountLimit(
        this.dataSource.manager,
        discount,
        customer?.id ?? null,
        null,
      );
    }

    const settings = await this.settingsService.getSettings(tenantId);
    const tax = await this.taxResolver.load(
      tenantId,
      variantList.map((v) => v.product.taxCategoryId),
    );

    // An estimate's quoted prices/discounts replace the catalog as the reference,
    // for its customer and up to the quantities it quoted
    const quoted = dto.estimateId
      ? await this.estimatesService.quotedLines(tenantId, dto.estimateId)
      : null;
    if (
      quoted?.estimate.customerId &&
      quoted.estimate.customerId !== (customer?.id ?? null)
    ) {
      throw new BadRequestException(
        `Estimate ${quoted.estimate.estimateNumber} is for another customer`,
      );
    }
    // Quoted units not used yet by earlier lines, per variant
    const quotedLeft = new Map(
      [...(quoted?.lines ?? new Map<string, { quantity: number }>())].map(
        ([variantId, line]) => [variantId, line.quantity],
      ),
    );

    const variants = new Map<string, ProductVariant>();
    const catalogPrices = new Map<string, number>();
    const quotedDiscounts = new Map<string, number>();
    const inputs: CalcLineInput[] = dto.items.map((item, index) => {
      const variant = byId.get(item.variantId)!;
      const key = `${index}`;
      // A line beyond the quoted quantity is sold at the catalog price
      const left = quotedLeft.get(variant.id) ?? 0;
      const quote =
        item.quantity <= left ? quoted?.lines.get(variant.id) : undefined;
      if (quote) quotedLeft.set(variant.id, subQty(left, item.quantity));
      const catalogPrice = quote ? quote.unitPrice : catalog.get(variant.id)!;
      if (quote) quotedDiscounts.set(key, quote.discountPercent);
      variants.set(key, variant);
      catalogPrices.set(key, catalogPrice);
      const price = quote ? quote.unitPrice : prices.get(variant.id)!;
      return {
        key,
        productId: variant.productId,
        categoryId: variant.product.categoryId ?? null,
        quantity: item.quantity,
        unitPrice: item.unitPrice !== undefined ? item.unitPrice : price,
        discountPercent: item.discountPercent,
        taxRate: tax.rateFor(variant.product.taxCategoryId),
      };
    });

    const options: CalcOptions = {
      taxRate: tax.defaultRate,
      pricesIncludeTax: settings.pricesIncludeTax,
      discount: discount && {
        ...discount,
        value: discount.value != null ? Number(discount.value) : null,
        percentage:
          discount.percentage != null ? Number(discount.percentage) : null,
        minPurchaseAmount:
          discount.minPurchaseAmount != null
            ? Number(discount.minPurchaseAmount)
            : null,
        maxDiscountAmount:
          discount.maxDiscountAmount != null
            ? Number(discount.maxDiscountAmount)
            : null,
      },
      cartDiscount: dto.cartDiscount,
    };
    let calc = calculateSale(inputs, options);
    // Gift cards: their own lines, no tax, no discount (a liability, not revenue)
    if (giftCards.length) {
      const giftVariant = await ensureGiftCardVariant(
        this.dataSource.manager,
        tenantId,
      );
      giftCards.forEach((card, index) => {
        variants.set(`gc${index}`, giftVariant);
        catalogPrices.set(`gc${index}`, card.amount);
      });
      calc = withGiftCardLines(calc, giftCards, giftVariant.productId);
    }

    // Discounts already on the estimate were authorised when it was written
    const sameCartDiscount =
      !!quoted?.estimate.cartDiscount &&
      !!dto.cartDiscount &&
      quoted.estimate.cartDiscount.type === dto.cartDiscount.type &&
      Number(quoted.estimate.cartDiscount.value) >= dto.cartDiscount.value;
    const overrideLines = inputs.map((input) => ({
      key: input.key,
      catalogPrice: catalogPrices.get(input.key)!,
      unitPrice: input.unitPrice,
      discountPercent:
        (input.discountPercent ?? 0) <= (quotedDiscounts.get(input.key) ?? -1)
          ? 0
          : input.discountPercent,
    }));
    const cartPercent = sameCartDiscount
      ? 0
      : cartDiscountPercent(inputs, options);
    const maxPercent = Number(settings.maxDiscountPercent);
    const overrides = requiredOverrides(overrideLines, cartPercent, maxPercent);
    // Discounts that need a manager's override also need a written reason
    const reasonsNeeded = {
      lines: overrideLines
        .filter((l) => (l.discountPercent ?? 0) > maxPercent)
        .map((l) => l.key),
      cart: cartPercent > maxPercent,
    };

    return {
      register,
      branch,
      customer,
      discount,
      variants,
      catalogPrices,
      calc,
      taxRate: tax.defaultRate,
      settings,
      overrides,
      items: dto.items,
      reasonsNeeded,
      giftCards,
      units,
    };
  }

  /**
   * Rules a sale must meet before it is taken online (offline sales already
   * happened and skip them; hold does not sell):
   * - a written reason for every discount above the store limit (manager override)
   * - a total of 0.00 only when the store allows it, and then only with
   *   pos.discount.override (added to the cart's required overrides, so a
   *   manager's approval works too)
   */
  private checkPolicies(prepared: PreparedSale, dto: QuoteSaleDto) {
    const max = Number(prepared.settings.maxDiscountPercent);
    for (const key of prepared.reasonsNeeded.lines) {
      if (!prepared.items[Number(key)]?.discountReason?.trim()) {
        throw new BadRequestException(
          `Give a reason for the discount on line ${Number(key) + 1} (above ${max}%)`,
        );
      }
    }
    if (prepared.reasonsNeeded.cart && !dto.cartDiscount?.reason?.trim()) {
      throw new BadRequestException(
        `Give a reason for the discount on the sale (above ${max}%)`,
      );
    }

    if (prepared.calc.lines.length > 0 && prepared.calc.total <= 0) {
      if (!prepared.settings.allowZeroValueSales) {
        throw new BadRequestException(
          'This store does not allow sales with a total of 0.00',
        );
      }
      const { overrides } = prepared;
      if (!overrides.permissions.includes('pos.discount.override')) {
        overrides.permissions = [
          ...overrides.permissions.filter((p) => p !== 'pos.discount'),
          'pos.discount.override',
        ];
      }
      overrides.reasons.push('Sale with a total of 0.00');
    }
  }

  /**
   * The staff member credited with a sale: an active member of the store who
   * sells. A sale synced from offline keeps a salesperson who has left since
   * the sale (any membership); one who never belonged to the store is dropped.
   */
  private async resolveSalesperson(
    tenantId: string,
    salespersonId: string | undefined,
    offline: boolean,
  ): Promise<string | null> {
    if (!salespersonId) return null;
    const [member] = await sellingStaff(
      this.dataSource.manager,
      tenantId,
      salespersonId,
    );
    if (member) return member.id;
    if (offline) {
      const known = await this.dataSource.manager.count(TenantMembership, {
        where: { tenantId, userId: salespersonId },
      });
      return known > 0 ? salespersonId : null;
    }
    throw new BadRequestException(
      'The salesperson must be an active member of this store who can sell',
    );
  }

  /**
   * Check the discounts / price changes in the cart against the user's permissions,
   * or a manager's approval token(s) (X-Approval-Token, comma-separated for several).
   * Returns who approved what.
   */
  private async authorize(
    user: AuthUser,
    prepared: PreparedSale,
    approvalToken?: string,
  ): Promise<{ permission: Permission; approverId: string }[]> {
    const tokens = (approvalToken ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const approvals: { permission: Permission; approverId: string }[] = [];
    for (const permission of prepared.overrides.permissions) {
      if (user.permissions?.includes(permission)) continue;
      let approverId: string | null = null;
      for (const token of tokens) {
        approverId = await this.approvalsService.verify(
          token,
          permission,
          user,
        );
        if (approverId) break;
      }
      if (!approverId) {
        const message =
          OVERRIDE_MESSAGES[permission]?.(
            Number(prepared.settings.maxDiscountPercent),
          ) ?? 'This needs a manager approval';
        throw approvalRequired(permission, message);
      }
      approvals.push({ permission, approverId });
    }
    return approvals;
  }

  private async auditOverrides(
    manager: EntityManager,
    tenantId: string,
    sale: Sale,
    prepared: PreparedSale,
    approvals: { permission: Permission; approverId: string }[],
    offline: boolean,
  ) {
    const { overrides, calc, catalogPrices } = prepared;
    const approverFor = (permission: Permission) =>
      approvals.find((a) => a.permission === permission)?.approverId;

    if (overrides.permissions.includes('pos.price.override')) {
      await this.auditService.record(
        {
          tenantId,
          action: 'sale.price_override',
          entityType: 'sale',
          entityId: sale.id,
          approverId: approverFor('pos.price.override') ?? undefined,
          metadata: {
            saleNumber: sale.saleNumber,
            offline,
            lines: calc.lines
              .filter(
                (l) =>
                  round2(l.unitPrice) !== round2(catalogPrices.get(l.key)!),
              )
              .map((l) => ({
                line: Number(l.key) + 1,
                variantId: prepared.variants.get(l.key)!.id,
                catalogPrice: catalogPrices.get(l.key),
                unitPrice: l.unitPrice,
                quantity: l.quantity,
              })),
          },
        },
        manager,
      );
    }
    if (overrides.permissions.includes('pos.discount.override')) {
      await this.auditService.record(
        {
          tenantId,
          action: 'sale.discount_override',
          entityType: 'sale',
          entityId: sale.id,
          approverId: approverFor('pos.discount.override') ?? undefined,
          reason: overrides.reasons.join('; ').slice(0, 500),
          metadata: {
            saleNumber: sale.saleNumber,
            offline,
            maxPercent: overrides.maxPercent,
            limit: prepared.settings.maxDiscountPercent,
            discountAmount: calc.discountAmount,
          },
        },
        manager,
      );
    }
  }

  /**
   * Sales from a revoked till are refused, except offline sales rung up before the
   * revocation (they already happened). Returns the device when such a sale is let
   * through, so it can be audited with the sale.
   */
  private async checkDevice(
    tenantId: string,
    deviceId: string | null,
    dto: CreateSaleDto,
  ): Promise<Device | null> {
    if (!deviceId) return null;
    const device = await this.dataSource
      .getRepository(Device)
      .findOne({ where: { id: deviceId, tenantId } });
    if (!device?.revokedAt) return null;
    const revokedAt = new Date(device.revokedAt);
    if (dto.offlineCapturedAt && new Date(dto.offlineCapturedAt) < revokedAt) {
      return device;
    }
    await this.auditService.record({
      tenantId,
      action: 'sale.revoked_device_rejected',
      entityType: 'device',
      entityId: deviceId,
      metadata: {
        revokedAt,
        offlineCapturedAt: dto.offlineCapturedAt ?? null,
        offlineNumber: dto.offlineNumber ?? null,
        idempotencyKey: dto.idempotencyKey ?? null,
      },
    });
    throw new ForbiddenException(
      'This till has been revoked by an administrator and cannot record sales',
    );
  }

  /** The open shift of the register; required when the store says so */
  /**
   * The shift a sale belongs to. Online: the register's open shift (required when the
   * store says so). Offline: the shift that was open on the register when the sale was
   * captured, so its cash counts in the drawer it went into — even if that shift has
   * closed since (it then shows as a late upload on that shift, not in today's drawer);
   * with no shift open at the time, the register's open shift.
   */
  private async resolveShift(
    tenantId: string,
    registerId: string,
    settings: StoreSettings,
    capturedAt: Date | null,
  ): Promise<string | null> {
    if (capturedAt) {
      const atCapture = await this.dataSource
        .getRepository(Shift)
        .createQueryBuilder('shift')
        .select('shift.id', 'id')
        .where('shift.tenantId = :tenantId', { tenantId })
        .andWhere('shift.registerId = :registerId', { registerId })
        .andWhere('shift.openedAt <= :at', { at: capturedAt })
        .andWhere('(shift.closedAt IS NULL OR shift.closedAt >= :at)', {
          at: capturedAt,
        })
        .orderBy('shift.openedAt', 'DESC')
        .limit(1)
        .getRawOne<{ id: string }>();
      if (atCapture) return atCapture.id;
      // No shift was open then: the drawer that is open now takes the cash (none:
      // the caller opens a review case, the cash is never silently in no drawer)
      const open = await this.shiftsService.getOpenShift(tenantId, registerId);
      return open?.id ?? null;
    }
    const shift = await this.shiftsService.getOpenShift(tenantId, registerId);
    if (!shift && settings.requireOpenShift) {
      throw new ConflictException(
        'Open a shift on this register before selling',
      );
    }
    return shift?.id ?? null;
  }

  private itemRows(
    manager: EntityManager,
    tenantId: string,
    saleId: string,
    prepared: PreparedSale,
    costs: Map<string, number>,
  ): SaleItem[] {
    return prepared.calc.lines.map((line, index) => {
      const variant = prepared.variants.get(line.key)!;
      const catalogPrice = prepared.catalogPrices.get(line.key)!;
      const input = prepared.items[Number(line.key)];
      return manager.create(SaleItem, {
        tenantId,
        saleId,
        variantId: variant.id,
        sku: variant.sku,
        productName: variant.product.name?.en ?? variant.sku,
        variantName: variant.name?.en,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        originalUnitPrice:
          round2(line.unitPrice) !== round2(catalogPrice) ? catalogPrice : null,
        subtotal: line.subtotal,
        discountAmount: line.discountAmount,
        taxAmount: line.taxAmount,
        taxRate: line.taxRate ?? prepared.taxRate,
        total: line.total,
        cost: costs.get(line.key) ?? variant.cost ?? undefined,
        lineNumber: index + 1,
        notes: input?.note?.trim() || undefined,
        metadata: {
          ...(line.discountPercent && line.discountPercent > 0
            ? { discountPercent: line.discountPercent }
            : {}),
          ...(input?.discountReason?.trim() &&
          line.discountPercent &&
          line.discountPercent > 0
            ? { discountReason: input.discountReason.trim() }
            : {}),
          ...(isStockTracked(variant) ? {} : { stockTracked: false }),
          // Measured item (kg, m, l): printed as "1.250 kg × 3.99/kg"
          ...unitMetadata(prepared.units.get(variant.id)),
          // Gift card sold: stored value (a liability), left out of net sales
          ...(isGiftCardLineKey(line.key)
            ? {
                storedValue: true,
                giftCard: true,
                giftCardIndex: Number(line.key.slice(2)),
              }
            : {}),
        },
      });
    });
  }

  /**
   * Lock a held or resumed cart for the rest of the transaction
   */
  private async lockOpenCart(
    manager: EntityManager,
    tenantId: string,
    id: string,
  ): Promise<Sale> {
    const cart = await manager.findOne(Sale, {
      where: { id, tenantId },
      lock: { mode: 'pessimistic_write' },
    });
    // Another branch's cart is "not found" (spec §9)
    if (!cart || !canAccessBranch(cart.branchId)) {
      throw new NotFoundException('Held cart not found');
    }
    if (!OPEN_CART_STATUSES.includes(cart.status)) {
      throw new ConflictException(
        `This cart is already ${cart.status.replace('_', ' ')}`,
      );
    }
    return cart;
  }

  private async cancelCart(
    manager: EntityManager,
    sale: Sale,
    reason: string,
    system: boolean,
  ) {
    await this.releaseStock(manager, sale.tenantId, sale.id);
    // Points spent on a sale that never completed go back to the customer
    await this.loyaltyService.reverseSale(
      manager,
      sale.tenantId,
      sale.id,
      `Cancelled ${sale.saleNumber}`,
    );
    // So do the account charge, gift card / store credit spent, pending gift cards
    await this.reverseStoredValueAndCredit(
      manager,
      sale.tenantId,
      sale.id,
      `Cancelled ${sale.saleNumber}`,
    );
    // Cash taken for a sale that never completed goes back to the customer
    await manager.update(
      Payment,
      {
        saleId: sale.id,
        tenantId: sale.tenantId,
        status: PaymentStatus.COMPLETED,
      },
      { status: PaymentStatus.REFUNDED },
    );
    // So does the discount code use taken at checkout (once: the flag is cleared)
    const discountId = sale.metadata?.discountId as string | null | undefined;
    const releaseDiscount = !!discountId && !!sale.metadata?.discountConsumed;
    if (releaseDiscount) {
      await manager.query(
        `UPDATE discounts SET "usageCount" = GREATEST("usageCount" - 1, 0), updated_at = NOW()
          WHERE id = $1 AND "tenantId" = $2`,
        [discountId, sale.tenantId],
      );
    }
    await manager.update(
      Sale,
      { id: sale.id, tenantId: sale.tenantId },
      {
        status: SaleStatus.CANCELLED,
        heldUntil: null,
        notes: [sale.notes, reason].filter(Boolean).join(' · ').slice(0, 255),
        ...(releaseDiscount && {
          metadata: () => `metadata || '{"discountConsumed": false}'::jsonb`,
        }),
      },
    );
    await this.auditService.record(
      {
        tenantId: sale.tenantId,
        action: system ? 'sale.hold_expired' : 'sale.cancelled',
        entityType: 'sale',
        entityId: sale.id,
        reason,
        actorId: system ? null : undefined,
        metadata: {
          saleNumber: sale.saleNumber,
          from: sale.status,
          total: sale.total,
        },
      },
      manager,
    );
  }

  /** Cancel held/resumed carts whose hold has lapsed (and free their stock) */
  private async expireHeldCarts(tenantId: string) {
    const expired = await this.saleRepository.find({
      select: { id: true },
      where: {
        tenantId,
        status: In([...OPEN_CART_STATUSES]),
        heldUntil: LessThan(new Date()),
      },
      take: 100,
    });
    for (const { id } of expired) {
      await this.dataSource.transaction(async (manager) => {
        const sale = await manager.findOne(Sale, {
          where: { id, tenantId },
          lock: { mode: 'pessimistic_write' },
        });
        if (
          sale &&
          OPEN_CART_STATUSES.includes(sale.status) &&
          sale.heldUntil &&
          new Date(sale.heldUntil) < new Date()
        ) {
          await this.cancelCart(manager, sale, 'Hold expired', true);
        }
      });
    }
  }

  private releaseStock(
    manager: EntityManager,
    tenantId: string,
    saleId: string,
    committed = false,
  ) {
    return this.inventoryService.releaseReservations(manager, {
      tenantId,
      referenceType: SALE_REFERENCE,
      referenceId: saleId,
      status: committed
        ? ReservationStatus.COMMITTED
        : ReservationStatus.RELEASED,
    });
  }

  /**
   * What the POS needs to rebuild its cart from a held sale
   */
  private async toCart(tenantId: string, sale: Sale) {
    const variantIds = sale.items.map((i) => i.variantId);
    const variants = variantIds.length
      ? await this.dataSource.getRepository(ProductVariant).find({
          where: { tenantId, id: In(variantIds) },
          relations: VARIANT_UNIT_RELATIONS,
        })
      : [];
    const byId = new Map(variants.map((v) => [v.id, v]));
    const register = await this.dataSource
      .getRepository(Register)
      .findOne({ where: { id: sale.registerId, tenantId } });
    const levels =
      register?.defaultLocationId && variantIds.length
        ? await this.dataSource.getRepository(StockLevel).find({
            where: {
              tenantId,
              variantId: In(variantIds),
              locationId: register.defaultLocationId,
            },
          })
        : [];
    const stock = new Map(
      levels.map((l) => [
        l.variantId,
        subQty(l.quantityOnHand, l.quantityReserved),
      ]),
    );

    const cart = (sale.metadata?.cart ?? {}) as {
      priceListId?: string | null;
      discountCode?: string | null;
      cartDiscount?: { type: 'percentage' | 'fixed'; value: number } | null;
    };

    return {
      heldSaleId: sale.id,
      customerId: sale.customerId ?? null,
      salespersonId: sale.salespersonId ?? null,
      discountCode: cart.discountCode ?? null,
      cartDiscount: cart.cartDiscount ?? null,
      priceListId: cart.priceListId ?? null,
      notes: sale.notes ?? '',
      items: sale.items.map((item) => {
        const variant = byId.get(item.variantId);
        const onShelf = stock.get(item.variantId);
        const stockTracked = variant
          ? isStockTracked(variant)
          : lineTracksStock(item);
        return {
          variantId: item.variantId,
          productId: variant?.productId ?? '',
          categoryId: variant?.product.categoryId ?? null,
          productName: item.productName,
          variantName: item.variantName ?? null,
          sku: item.sku,
          quantity: item.quantity,
          unitPrice: Number(item.unitPrice),
          catalogPrice: Number(item.originalUnitPrice ?? item.unitPrice),
          discountPercent: Number(
            (item.metadata?.discountPercent as number | undefined) ?? 0,
          ),
          taxRate: item.taxRate != null ? Number(item.taxRate) : null,
          // This cart's own reservation counts as available to it
          stock:
            onShelf === undefined || !stockTracked
              ? null
              : addQty(onShelf, item.quantity),
          stockTracked,
          // Measured items (kg, m, l): decimal quantities, shown with the unit
          unit: variant ? catalogUnit(unitOfVariant(variant)) : null,
          allowBackorder: variant?.product.allowBackorder ?? false,
          note: item.notes ?? null,
          discountReason:
            (item.metadata?.discountReason as string | undefined) ?? null,
        };
      }),
    };
  }

  private toQuote({
    calc,
    variants,
    discount,
    taxRate,
    branch,
    catalogPrices,
    overrides,
  }: PreparedSale) {
    return {
      currencyCode: branch.currencyCode,
      taxRate,
      discountCode: discount?.code ?? null,
      discountMessage: calc.discountMessage ?? null,
      subtotal: calc.subtotal,
      discountAmount: calc.discountAmount,
      taxAmount: calc.taxAmount,
      total: calc.total,
      // Permissions the cart uses (the user has them or brought an approval)
      overrides: overrides.permissions,
      lines: calc.lines.map((line) => {
        const variant = variants.get(line.key)!;
        return {
          variantId: variant.id,
          sku: variant.sku,
          productName: variant.product.name?.en ?? variant.sku,
          variantName: variant.name?.en ?? null,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          catalogPrice: catalogPrices.get(line.key)!,
          subtotal: line.subtotal,
          discountAmount: line.discountAmount,
          taxRate: line.taxRate ?? taxRate,
          taxAmount: line.taxAmount,
          total: line.total,
        };
      }),
    };
  }

  /**
   * Payments must cover the total. Overpaying is only allowed in cash (it becomes change).
   */
  private async validatePayments(
    tenantId: string,
    dto: CreateSaleDto,
    total: number,
    currency: {
      saleCurrency: string;
      settings: StoreSettings;
      offline: boolean;
      exchange?: SaleCreateOptions['exchange'];
    },
  ): Promise<{
    rows: ValidatedPayment[];
    amountPaid: number;
    change: number;
    changeTender: SaleChangeTender | null;
    onAccountTotal: number;
    offlineRates: OfflineRateUse[];
  }> {
    const methodIds = [...new Set(dto.payments.map((p) => p.paymentMethodId))];
    // No payments at all: a zero-value sale (checked in checkPolicies)
    const methods = methodIds.length
      ? await this.dataSource.getRepository(PaymentMethod).find({
          where: { tenantId, id: In(methodIds) },
        })
      : [];
    const byId = new Map(methods.map((m) => [m.id, m]));
    const { saleCurrency, settings, offline } = currency;
    const rateTo = (code: string) =>
      exchangeRate(
        settings.exchangeRates,
        settings.currencyCode,
        saleCurrency,
        code.toUpperCase(),
      );

    // Cash handed over, valued at the store's rates (what change may come out of)
    let cashTotal = 0;
    let loyaltyTotal = 0;
    // Exact (unrounded) value of what was paid, in the sale currency
    let exactPaid = 0;
    // The same at the store's rates (differs only for offline till rates)
    let exactPaidAtStoreRates = 0;
    const offlineRates: OfflineRateUse[] = [];
    const rows: ValidatedPayment[] = [];
    for (const payment of dto.payments) {
      const method = byId.get(payment.paymentMethodId);
      if (!method || method.status !== PaymentMethodStatus.ACTIVE) {
        throw new BadRequestException('Payment method not found or inactive');
      }
      const special = specialTenderOf(method);
      if (special && offline) {
        throw new BadRequestException(
          `${method.name?.en ?? method.code} can't be used offline`,
        );
      }
      const async =
        method.methodType !== PaymentMethodType.CASH &&
        this.paymentsService.providerOf(method).async;
      // Integrated terminals return their own reference; the cashier types none
      if (method.requiresReference && !payment.reference && !async) {
        throw new BadRequestException(
          `${method.name?.en ?? method.code} payments need a reference`,
        );
      }

      let amount = payment.amount;
      let exact = payment.amount;
      let atStoreRate = payment.amount;
      let tendered: ValidatedPayment['tendered'] = null;
      const code = payment.currencyCode?.toUpperCase();
      if (code && code !== saleCurrency) {
        if (this.loyaltyService.isLoyaltyMethod(method)) {
          throw new BadRequestException(
            'Points are always spent in the store currency',
          );
        }
        if (special) {
          throw new BadRequestException(
            `${method.name?.en ?? method.code} is always paid in the store currency`,
          );
        }
        const current = rateTo(code);
        if (!current) {
          throw new BadRequestException(
            `${code} is not accepted by this store`,
          );
        }
        if (!payment.tenderedAmount) {
          throw new BadRequestException(
            `Give the amount paid in ${code} (tenderedAmount)`,
          );
        }
        // A sale recorded offline keeps the rate the till had at the time, if it
        // is close to the store's (else the store's); either way it is reviewed
        let rate = current;
        const tillRate = offline ? payment.exchangeRate : undefined;
        if (tillRate && Math.abs(tillRate / current - 1) > 1e-9) {
          if (Math.abs(tillRate / current - 1) <= MAX_OFFLINE_RATE_DRIFT) {
            rate = tillRate;
          }
          offlineRates.push({
            currencyCode: code,
            tillRate,
            storeRate: current,
            appliedRate: rate,
          });
        }
        atStoreRate = toSaleCurrency(payment.tenderedAmount, current);
        exact = toSaleCurrency(payment.tenderedAmount, rate);
        amount = round2(exact);
        tendered = {
          currencyCode: code,
          amount: round2(payment.tenderedAmount),
          rate,
        };
      }
      exactPaid += exact;
      exactPaidAtStoreRates += atStoreRate;
      if (method.methodType === PaymentMethodType.CASH) {
        cashTotal += tendered ? round2(atStoreRate) : amount;
      }
      if (this.loyaltyService.isLoyaltyMethod(method)) {
        loyaltyTotal += amount;
      }
      rows.push({ ...payment, amount, method, tendered, special });
    }

    // Foreign amounts are asked for rounded up, so compare the exact value
    // (half a cent of rounding noise is tolerated)
    if (exactPaid < total - 0.005) {
      throw new BadRequestException(
        `Payments (${round2(exactPaid).toFixed(2)}) do not cover the total (${total.toFixed(2)})`,
      );
    }
    // Rounding each foreign payment may leave the rows a cent short of the total:
    // the last foreign payment absorbs it so payments always add up
    let amountPaid = round2(rows.reduce((sum, p) => sum + p.amount, 0));
    if (amountPaid < total) {
      const last = [...rows].reverse().find((p) => p.tendered);
      if (last) {
        last.amount = round2(last.amount + (total - amountPaid));
        amountPaid = total;
      }
    }
    const change = round2(Math.max(0, amountPaid - total));
    if (change > round2(cashTotal)) {
      throw new BadRequestException('Only cash payments can exceed the total');
    }
    // A till's own rate never gives back more than was paid at the store's rates
    if (
      offlineRates.length > 0 &&
      change > round2(Math.max(0, exactPaidAtStoreRates - total)) + 0.01
    ) {
      throw new BadRequestException(
        "The change is more than what was paid at the store's exchange rates",
      );
    }

    let changeTender: SaleChangeTender | null = null;
    const changeCode = dto.changeCurrency?.toUpperCase();
    if (change > 0 && changeCode && changeCode !== saleCurrency) {
      const rate = rateTo(changeCode);
      if (!rate) {
        throw new BadRequestException(
          `${changeCode} is not accepted by this store`,
        );
      }
      // From the exact overpayment: 2000 HTG for a 1325 HTG sale gives back 675 HTG
      changeTender = {
        currencyCode: changeCode,
        amount: changeIn(Math.max(0, exactPaid - total), rate),
        exchangeRate: rate,
      };
    }

    // Paying with points: the customer must have enough, within the store's limits
    if (loyaltyTotal > 0) {
      const customer = dto.customerId
        ? await this.dataSource
            .getRepository(Customer)
            .findOne({ where: { id: dto.customerId, tenantId } })
        : null;
      await this.loyaltyService.validateRedemption(
        tenantId,
        customer,
        round2(loyaltyTotal),
        total,
      );
    }

    const onAccountTotal = await this.checkSpecialTenders(
      tenantId,
      dto,
      rows,
      currency.exchange,
    );
    return {
      rows,
      amountPaid,
      change,
      changeTender,
      onAccountTotal,
      offlineRates,
    };
  }

  /**
   * On account, gift cards, store credit and exchange credit: who may use them
   * and whether the balance is there (checked again atomically when spent).
   * Returns what goes on the customer's account.
   */
  private async checkSpecialTenders(
    tenantId: string,
    dto: CreateSaleDto,
    rows: ValidatedPayment[],
    exchange: SaleCreateOptions['exchange'],
  ): Promise<number> {
    const cents = (value: number) => Math.round(value * 100);
    let onAccount = 0;
    let exchangeCredit = 0;
    const spend = new Map<
      string,
      { account: StoredValueAccount; cents: number }
    >();
    for (const row of rows) {
      if (!row.special) continue;
      if (row.special === ON_ACCOUNT_CODE) {
        onAccount += cents(row.amount);
        continue;
      }
      if (row.special === EXCHANGE_CREDIT_CODE) {
        if (!exchange) {
          throw new BadRequestException(
            'Exchange credit can only pay for the new sale of an exchange',
          );
        }
        exchangeCredit += cents(row.amount);
        continue;
      }
      let account: StoredValueAccount | null;
      if (row.special === GIFT_CARD_CODE) {
        if (!row.giftCardCode?.trim()) {
          throw new BadRequestException('Enter or scan the gift card code');
        }
        account = await this.storedValue.findGiftCardByCode(
          this.dataSource.manager,
          tenantId,
          row.giftCardCode,
        );
        // One answer for unknown / inactive / expired cards: codes can't be probed
        if (!account) throw new BadRequestException(GIFT_CARD_UNUSABLE);
      } else {
        if (!dto.customerId) {
          throw new BadRequestException(
            'Choose the customer to pay with store credit',
          );
        }
        account = await this.dataSource
          .getRepository(StoredValueAccount)
          .findOne({
            where: {
              tenantId,
              customerId: dto.customerId,
              accountType: StoredValueType.STORE_CREDIT,
              status: StoredValueStatus.ACTIVE,
            },
          });
        if (!account) {
          throw new BadRequestException('This customer has no store credit');
        }
      }
      const expired =
        !!account.expiresAt && new Date(account.expiresAt) <= new Date();
      if (account.status !== StoredValueStatus.ACTIVE || expired) {
        throw new BadRequestException(
          account.accountType === StoredValueType.GIFT_CARD
            ? GIFT_CARD_UNUSABLE
            : 'This store credit can no longer be used',
        );
      }
      row.storedValueAccountId = account.id;
      // Never the code: only the last 4 characters are kept on the payment
      row.reference = account.last4 ? `****${account.last4}` : row.reference;
      const entry = spend.get(account.id) ?? { account, cents: 0 };
      entry.cents += cents(row.amount);
      spend.set(account.id, entry);
    }
    for (const { account, cents: wanted } of spend.values()) {
      if (wanted > cents(Number(account.balance))) {
        throw new BadRequestException(
          account.accountType === StoredValueType.GIFT_CARD
            ? 'The gift card balance is not enough for this payment'
            : `The customer has ${Number(account.balance).toFixed(2)} of store credit`,
        );
      }
    }
    if (exchange && exchangeCredit !== cents(exchange.creditAmount)) {
      throw new BadRequestException(
        `The exchange credit (${exchange.creditAmount.toFixed(2)}) must be used in full`,
      );
    }
    if (onAccount > 0 && !dto.customerId) {
      throw new BadRequestException('Choose the customer to sell on account');
    }
    return onAccount / 100;
  }

  /**
   * Selling on account needs customers.credit.sell (or a manager's approval), a
   * customer who is not on credit hold, and customers.credit.override (or an
   * approval) to go over the credit limit
   */
  private async authorizeOnAccount(
    tenantId: string,
    user: AuthUser,
    customer: Customer | null,
    amount: number,
    approvalToken?: string,
  ): Promise<OnAccountApproval> {
    if (!customer) {
      throw new BadRequestException('Choose the customer to sell on account');
    }
    if (customer.creditHold) {
      throw new BadRequestException(
        'This customer is on credit hold: no new sales on account',
      );
    }
    const tokens = (approvalToken ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    let approverId: string | null = null;
    if (!user.permissions?.includes('customers.credit.sell')) {
      approverId = await this.verifyAny(tokens, 'customers.credit.sell', user);
      if (!approverId) {
        throw approvalRequired(
          'customers.credit.sell',
          "Selling on account needs a manager's approval",
        );
      }
    }
    const check = await this.customerCredit.checkCharge(
      tenantId,
      customer.id,
      amount,
    );
    if (!check.exceedsLimit) return { allowOverLimit: false, approverId };
    if (!user.permissions?.includes('customers.credit.override')) {
      const over = await this.verifyAny(
        tokens,
        'customers.credit.override',
        user,
      );
      if (!over) {
        throw approvalRequired(
          'customers.credit.override',
          user.permissions?.includes('customers.finance.view')
            ? `This sale takes the customer over their credit limit (${check.available.toFixed(2)} available). A manager's approval is needed.`
            : "This sale takes the customer over their credit limit. A manager's approval is needed.",
        );
      }
      approverId = approverId ?? over;
    }
    return { allowOverLimit: true, approverId };
  }

  private async verifyAny(
    tokens: string[],
    permission: Permission,
    user: AuthUser,
  ): Promise<string | null> {
    for (const token of tokens) {
      const approverId = await this.approvalsService.verify(
        token,
        permission,
        user,
      );
      if (approverId) return approverId;
    }
    return null;
  }

  /** Post what the special tenders do, in the sale transaction */
  private async postSpecialTenders(
    manager: EntityManager,
    input: {
      tenantId: string;
      sale: Sale;
      customerId: string | null;
      rows: ValidatedPayment[];
      saved: Payment[];
      onAccountTotal: number;
      onAccount: OnAccountApproval | null;
      exchange: SaleCreateOptions['exchange'];
    },
  ) {
    const { tenantId, sale } = input;
    for (const [index, row] of input.rows.entries()) {
      if (
        (row.special === GIFT_CARD_CODE || row.special === STORE_CREDIT_CODE) &&
        row.storedValueAccountId
      ) {
        await this.storedValue.redeem(manager, {
          tenantId,
          accountId: row.storedValueAccountId,
          amount: row.amount,
          saleId: sale.id,
          paymentId: input.saved[index]?.id ?? null,
        });
      }
    }
    if (input.onAccountTotal > 0 && input.customerId) {
      await this.customerCredit.chargeSale(manager, {
        tenantId,
        customerId: input.customerId,
        saleId: sale.id,
        saleNumber: sale.saleNumber,
        amount: input.onAccountTotal,
        saleDate: new Date(sale.saleDate),
        allowOverLimit: input.onAccount?.allowOverLimit ?? false,
        approverId: input.onAccount?.approverId ?? null,
      });
    }
    if (input.exchange) {
      const linked = returnedRows<{ id: string }>(
        await manager.query(
          `UPDATE exchange_links
              SET "newSaleId" = $1, status = 'completed', "failureReason" = NULL, updated_at = NOW()
            WHERE id = $2 AND "tenantId" = $3 AND "newSaleId" IS NULL
              AND status IN ('pending', 'incomplete')
          RETURNING id`,
          [sale.id, input.exchange.linkId, tenantId],
        ),
      );
      if (!linked.length) {
        throw new ConflictException('This exchange was already completed');
      }
    }
  }

  /** Undo a sale's account charge, stored value spent and gift cards sold */
  private async reverseStoredValueAndCredit(
    manager: EntityManager,
    tenantId: string,
    saleId: string,
    note: string,
  ) {
    await this.customerCredit.reverseSale(manager, tenantId, saleId, note);
    await this.storedValue.reverseSaleRedemptions(
      manager,
      tenantId,
      saleId,
      note,
    );
    await this.storedValue.voidSaleGiftCards(manager, {
      tenantId,
      saleId,
      note,
    });
  }

  /** sale.completed, in the transaction that completed the sale */
  private async emitCompleted(
    manager: EntityManager,
    sale: Pick<
      Sale,
      | 'id'
      | 'tenantId'
      | 'saleNumber'
      | 'registerId'
      | 'shiftId'
      | 'total'
      | 'currencyCode'
      | 'version'
    >,
    locationId: string | null,
    items: Pick<SaleItem, 'variantId' | 'quantity' | 'metadata'>[],
  ) {
    await this.outbox?.record(manager, {
      tenantId: sale.tenantId,
      type: 'sale.completed',
      aggregateId: sale.id,
      aggregateVersion: sale.version ?? null,
      payload: {
        saleId: sale.id,
        saleNumber: sale.saleNumber,
        registerId: sale.registerId ?? null,
        shiftId: sale.shiftId ?? null,
        total: Number(sale.total),
        currencyCode: sale.currencyCode,
        lines: items
          .filter((item) => lineTracksStock(item))
          .map((item) => ({
            variantId: item.variantId,
            locationId,
            quantity: item.quantity,
          })),
      },
    });
  }

  /**
   * Number of a completed sale: per branch, prefixed with the branch code
   * (D017), e.g. MAIN-000042. Sales numbered before that keep their S- number.
   */
  private branchNumber(
    manager: EntityManager,
    tenantId: string,
    branch: Pick<Branch, 'code'>,
  ) {
    return nextDocumentNumber(manager, {
      table: 'sales',
      column: 'saleNumber',
      tenantId,
      prefix: branchDocumentPrefix(branch.code),
    });
  }

  private nextNumber(
    manager: EntityManager,
    tenantId: string,
    prefix: 'H' | 'P',
  ) {
    // H: held carts, P: sales waiting for payment — provisional numbers,
    // replaced by the branch's number when the sale completes.
    return nextDocumentNumber(manager, {
      table: 'sales',
      column: 'saleNumber',
      tenantId,
      prefix,
    });
  }

  private async awardLoyalty(
    manager: EntityManager,
    tenantId: string,
    customerId: string | null | undefined,
    saleId: string,
    total: number,
    at: Date,
  ) {
    if (!customerId) return;
    await manager.update(
      Customer,
      { id: customerId, tenantId },
      { lastPurchaseAt: at },
    );
    // Points are earned on merchandise paid with money: not on gift cards sold
    // (stored value), nor on what was paid with points, gift cards, store credit,
    // exchange credit or on account (money earned on elsewhere, or not yet paid)
    const [{ notEarning }] = await manager.query<{ notEarning: string }[]>(
      `SELECT
         (SELECT COALESCE(SUM(p.amount), 0)
            FROM payments p JOIN payment_methods pm ON pm.id = p."paymentMethodId"
           WHERE p."saleId" = $1 AND pm.code = ANY($2))
       + (SELECT COALESCE(SUM(si.total), 0)
            FROM sale_items si
           WHERE si."saleId" = $1 AND (si.metadata->>'giftCard') = 'true')
         AS "notEarning"`,
      [saleId, NO_LOYALTY_TENDERS],
    );
    await this.loyaltyService.earn(manager, {
      tenantId,
      customerId,
      saleId,
      amountPaid: round2(Math.max(0, total - Number(notEarning))),
    });
  }

  /**
   * Take a use of a discount code for a sale. The guarded UPDATE enforces the
   * usage limit atomically and row-locks the discount until the transaction ends,
   * so concurrent registers queue here and the per-customer count below sees the
   * sales committed before it.
   */
  private async consumeDiscount(
    manager: EntityManager,
    discount: Discount,
    sale: { customerId: string | null; saleId: string },
  ) {
    const result = await manager.query<unknown[]>(
      `UPDATE discounts SET "usageCount" = "usageCount" + 1, updated_at = NOW()
        WHERE id = $1 AND "tenantId" = $2
          AND ("usageLimit" IS NULL OR "usageCount" < "usageLimit")
        RETURNING id`,
      [discount.id, discount.tenantId],
    );
    // TypeORM returns [rows, affected] for UPDATE ... RETURNING on Postgres
    const rows = Array.isArray(result[0]) ? result[0] : result;
    if (rows.length === 0) {
      throw new BadRequestException(
        'This discount has reached its usage limit',
      );
    }
    await this.checkCustomerDiscountLimit(
      manager,
      discount,
      sale.customerId,
      sale.saleId,
    );
  }

  /**
   * A code limited per customer needs a customer on the sale, who has used it
   * fewer times than allowed (completed sales and sales waiting for a card).
   */
  private async checkCustomerDiscountLimit(
    manager: EntityManager,
    discount: Discount,
    customerId: string | null,
    // The sale being recorded, not counted against its own customer
    saleId: string | null,
  ) {
    const limit = discount.usageLimitPerCustomer;
    if (limit == null) return;
    if (!customerId) {
      throw new BadRequestException(
        'This discount is limited per customer: add the customer to the sale',
      );
    }
    const [{ used }] = await manager.query<{ used: number }[]>(
      `SELECT COUNT(*)::int AS used FROM sales
        WHERE "tenantId" = $1 AND "customerId" = $2
          AND status IN ('completed', 'payment_pending')
          AND metadata->>'discountId' = $3
          AND ($4::uuid IS NULL OR id <> $4::uuid)`,
      [discount.tenantId, customerId, discount.id, saleId],
    );
    if (Number(used) >= limit) {
      throw new BadRequestException(
        limit === 1
          ? 'This customer has already used this discount'
          : `This customer has already used this discount ${limit} times`,
      );
    }
  }

  /**
   * An idempotency key seen before: the same request gets its sale back, another
   * cart under the same key is refused. Sales recorded before the request was
   * fingerprinted have no hash and are returned as before.
   */
  private async replay(
    tenantId: string,
    existing: Sale,
    requestHash: string,
  ): Promise<Sale> {
    const stored = existing.metadata?.requestHash as string | undefined;
    if (stored && stored !== requestHash) {
      throw new ConflictException(
        'This idempotency key was already used for a different sale',
      );
    }
    return this.findOne(tenantId, existing.id);
  }

  /**
   * Offline fields are only honoured for a sale uploaded by its till (sync push):
   * online they would skip the approvals, stock and price checks. The capture time
   * of an uploaded sale is required and may not be in the future.
   */
  static assertOfflineFields(dto: CreateSaleDto, offline: boolean) {
    if (!offline) {
      if (
        dto.offlineCapturedAt !== undefined ||
        dto.offlineNumber !== undefined ||
        dto.deviceSequence !== undefined
      ) {
        throw new BadRequestException(
          'Sales recorded offline are uploaded by the till through POST /sync/push',
        );
      }
      return;
    }
    if (!dto.offlineCapturedAt) {
      throw new BadRequestException('An offline sale needs its capture time');
    }
    const capturedAt = new Date(dto.offlineCapturedAt).getTime();
    if (capturedAt > Date.now() + CLOCK_TOLERANCE_MS) {
      throw new BadRequestException(
        "The sale's capture time is in the future (check the till's clock)",
      );
    }
  }

  /**
   * Fingerprint of what a sale request asks for (sha256 of a fixed-shape JSON).
   * Left out on purpose: fields that legitimately differ when the same sale is
   * sent again under its key. A till that loses the connection mid-checkout keeps
   * the key and queues the sale offline, adding offlineCapturedAt/offlineNumber,
   * the device id and sequence, the prices charged (unitPrice) and dropping the
   * held cart and estimate. The payment amounts still pin down the cart's value.
   */
  static requestHash(dto: CreateSaleDto): string {
    const canonical = {
      registerId: dto.registerId,
      customerId: dto.customerId ?? null,
      items: dto.items.map((item) => [
        item.variantId,
        item.quantity,
        item.discountPercent || null,
      ]),
      payments: dto.payments.map((p) => [
        p.paymentMethodId,
        p.amount,
        p.currencyCode?.toUpperCase() ?? null,
        p.tenderedAmount ?? null,
      ]),
      discountCode: dto.discountCode?.trim().toUpperCase() || null,
      cartDiscount: dto.cartDiscount
        ? [dto.cartDiscount.type, dto.cartDiscount.value]
        : null,
      // Only when present, so fingerprints of earlier sales stay the same
      ...(dto.giftCards?.length
        ? { giftCards: dto.giftCards.map((c) => [c.amount, c.code ?? null]) }
        : {}),
    };
    return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  }
}
