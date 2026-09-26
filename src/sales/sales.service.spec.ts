import { EstimatesService } from '../estimates/estimates.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { AuditService } from '../audit/audit.service';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { Sale } from '../database/entities/sale.entity';
import { Register, RegisterStatus } from '../database/entities/register.entity';
import { Branch } from '../database/entities/branch.entity';
import { Customer } from '../database/entities/customer.entity';
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
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { ALL_PERMISSIONS } from '../auth/permissions';
import { SettingsService } from '../settings/settings.service';
import { PricingService } from '../price-lists/pricing.service';
import { DiscountsService } from '../discounts/discounts.service';
import { InventoryService } from '../inventory/inventory.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { ShiftsService } from '../shifts/shifts.service';
import { PaymentsService } from '../payments/payments.service';
import {
  Sale as SaleEntity,
  SaleStatus,
} from '../database/entities/sale.entity';
import { PaymentStatus } from '../database/entities/payment.entity';
import { TaxResolverService } from './tax-resolver.service';
import { Device } from '../devices/device.entity';
import {
  DiscountScope,
  DiscountType,
} from '../database/entities/discount.entity';
import { CreateSaleDto } from './sales.dto';
import { Shift } from '../database/entities/shift.entity';
import { SalesService } from './sales.service';
import { CustomerCreditService } from '../customers/credit/customer-credit.service';
import { StoredValueService } from '../stored-value/stored-value.service';
import { OutboxService } from '../platform/outbox/outbox.service';
import { requestContext } from '../common/context/request-context';

const TENANT = 'tenant-1';
const USER = {
  id: 'user-1',
  tenantId: TENANT,
  role: 'owner',
  permissions: ALL_PERMISSIONS,
} as unknown as AuthUser;
const CASHIER = {
  id: 'cashier-1',
  tenantId: TENANT,
  role: 'cashier',
  permissions: ['pos.sell', 'pos.discount', 'pos.hold'],
} as unknown as AuthUser;

const register = {
  id: 'reg-1',
  tenantId: TENANT,
  branchId: 'branch-1',
  defaultLocationId: 'loc-1',
  status: RegisterStatus.ACTIVE,
};
const branch = {
  id: 'branch-1',
  tenantId: TENANT,
  code: 'main',
  name: 'Main street',
  phone: '509-1111',
  currencyCode: 'USD',
};
const variant = {
  id: 'var-1',
  productId: 'prod-1',
  sku: 'SKU-1',
  price: 10,
  cost: 4,
  status: VariantStatus.ACTIVE,
  name: null,
  product: {
    name: { en: 'Coffee' },
    status: ProductStatus.ACTIVE,
    categoryId: null,
    allowBackorder: false,
  },
};
const method = (
  id: string,
  methodType: PaymentMethodType,
  extra: Partial<PaymentMethod> = {},
) => ({
  id,
  code: id.toUpperCase(),
  name: { en: id },
  methodType,
  status: PaymentMethodStatus.ACTIVE,
  requiresReference: false,
  ...extra,
});
const methods = [
  method('cash', PaymentMethodType.CASH),
  method('card', PaymentMethodType.CARD),
  method('cheque', PaymentMethodType.CHECK, { requiresReference: true }),
  method('old', PaymentMethodType.OTHER, {
    status: PaymentMethodStatus.INACTIVE,
  }),
  method('terminal', PaymentMethodType.CARD, {
    provider: 'mock',
    requiresReference: true,
  }),
];

// Two coffees at 10.00, no tax → total 20.00
const saleDto = (
  payments: CreateSaleDto['payments'],
  extra: Partial<CreateSaleDto> = {},
): CreateSaleDto => ({
  registerId: register.id,
  items: [{ variantId: variant.id, quantity: 2 }],
  payments,
  ...extra,
});

describe('SalesService', () => {
  let service: SalesService;

  const saleRepository = { findOne: jest.fn(), findOneOrFail: jest.fn() };
  const repositories = new Map<unknown, Record<string, jest.Mock>>([
    [Register, { findOne: jest.fn(), findOneOrFail: jest.fn() }],
    [Branch, { findOneOrFail: jest.fn() }],
    [Customer, { findOne: jest.fn() }],
    [ProductVariant, { find: jest.fn() }],
    [PaymentMethod, { find: jest.fn() }],
    [Device, { findOne: jest.fn() }],
    // Offline sales look up the shift that was open when they were rung up
    [
      Shift,
      {
        findOne: jest.fn(),
        createQueryBuilder: jest.fn(() => {
          const qb = {
            select: () => qb,
            where: () => qb,
            andWhere: () => qb,
            orderBy: () => qb,
            limit: () => qb,
            getRawOne: () => Promise.resolve({ id: 'shift-at-capture' }),
          };
          return qb;
        }),
      },
    ],
  ]);
  const repo = (entity: unknown) => repositories.get(entity)!;

  const manager = {
    query: jest.fn(),
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    find: jest.fn((): Promise<unknown[]> => Promise.resolve([])),
    delete: jest.fn(),
    create: jest.fn((_entity: unknown, data: object) => data),
    save: jest.fn((data: object) =>
      Promise.resolve(Array.isArray(data) ? data : { id: 'sale-1', ...data }),
    ),
    update: jest.fn(),
    increment: jest.fn(),
  };
  const dataSource = {
    manager,
    query: jest.fn(),
    getRepository: jest.fn((entity: unknown) => repo(entity)),
    transaction: jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager),
    ),
  };
  const inventoryService = {
    applyMovement: jest.fn(() => Promise.resolve({ unitCost: 3.5 })),
    reserve: jest.fn(),
    releaseReservations: jest.fn(),
  };
  const settings = {
    pricesIncludeTax: false,
    maxDiscountPercent: 20,
    heldCartExpiryHours: 24,
    requireOpenShift: false,
  };
  const settingsService = {
    getSettings: jest.fn(() => Promise.resolve({ ...settings })),
    getDefaultTaxRate: jest.fn(() => Promise.resolve(null)),
  };
  const approvalsService = { verify: jest.fn(() => Promise.resolve(null)) };
  const shiftsService = {
    getOpenShift: jest.fn(() => Promise.resolve(null as { id: string } | null)),
  };
  const paymentsService = {
    providerOf: jest.fn((m: { provider?: string }) => ({
      name: m.provider ?? 'manual',
      async: m.provider === 'mock',
    })),
    startPayments: jest.fn(() => Promise.resolve()),
    onSaleSettled: jest.fn(),
    cancelSalePayments: jest.fn(() => Promise.resolve(true)),
  };
  const taxResolver = {
    load: jest.fn(() => Promise.resolve({ defaultRate: 0, rateFor: () => 0 })),
  };
  const audit = { record: jest.fn() };
  const customerCredit = {
    checkCharge: jest.fn(),
    chargeSale: jest.fn(),
    reverseSale: jest.fn(),
  };
  const storedValue = {
    findGiftCardByCode: jest.fn(),
    redeem: jest.fn(),
    createSaleGiftCards: jest.fn(() => Promise.resolve([])),
    activateSaleGiftCards: jest.fn(),
    reverseSaleRedemptions: jest.fn(),
    voidSaleGiftCards: jest.fn(),
  };
  const outbox = { record: jest.fn() };
  const discountsService = { findUsableByCode: jest.fn() };
  const pricingService = {
    resolvePrices: jest.fn((_tenantId: string, variants: { id: string }[]) =>
      Promise.resolve(new Map(variants.map((v) => [v.id, 10]))),
    ),
    needsPriceOverride: jest.fn(() => Promise.resolve(false)),
  };
  const estimatesService = {
    quotedLines: jest.fn(),
    lockOpen: jest.fn(),
    markConverted: jest.fn(),
  };
  const loyaltyService = {
    isLoyaltyMethod: (m: { code?: string }) => m.code === 'LOYALTY',
    validateRedemption: jest.fn(),
    redeem: jest.fn(),
    earn: jest.fn(),
    reverseSale: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    repo(Register).findOne.mockResolvedValue(register);
    repo(Branch).findOneOrFail.mockResolvedValue(branch);
    repo(ProductVariant).find.mockResolvedValue([variant]);
    repo(PaymentMethod).find.mockResolvedValue(methods);
    saleRepository.findOne.mockResolvedValue(null);
    settingsService.getSettings.mockImplementation(() =>
      Promise.resolve({ ...settings }),
    );
    shiftsService.getOpenShift.mockResolvedValue(null);
    approvalsService.verify.mockResolvedValue(null);
    // nextDocumentNumber: the branch's counter hands out the next number
    manager.query.mockImplementation((sql: string) =>
      Promise.resolve(
        sql.includes('document_sequences') ? [[{ lastValue: '42' }], 1] : [],
      ),
    );

    const module = await Test.createTestingModule({
      providers: [
        { provide: EstimatesService, useValue: estimatesService },
        { provide: LoyaltyService, useValue: loyaltyService },
        { provide: AuditService, useValue: audit },
        { provide: ApprovalsService, useValue: approvalsService },
        { provide: ShiftsService, useValue: shiftsService },
        { provide: PaymentsService, useValue: paymentsService },
        { provide: TaxResolverService, useValue: taxResolver },
        { provide: CustomerCreditService, useValue: customerCredit },
        { provide: StoredValueService, useValue: storedValue },
        { provide: OutboxService, useValue: outbox },
        SalesService,
        { provide: getRepositoryToken(Sale), useValue: saleRepository },
        { provide: DataSource, useValue: dataSource },
        { provide: SettingsService, useValue: settingsService },
        { provide: PricingService, useValue: pricingService },
        { provide: DiscountsService, useValue: discountsService },
        { provide: InventoryService, useValue: inventoryService },
      ],
    }).compile();
    service = module.get(SalesService);
    // findOne loads the full sale through a query builder; not under test here
    jest
      .spyOn(service, 'findOne')
      .mockImplementation((_tenantId, id) =>
        Promise.resolve({ id } as unknown as Sale),
      );
  });

  // Offline sales are only honoured when uploaded by their till (sync push),
  // which passes the device it checked
  const OFFLINE = (deviceId: string | null = null) => ({
    offline: { deviceId },
  });

  const savedSale = () =>
    manager.save.mock.calls[0][0] as {
      saleNumber: string;
      total: number;
      amountPaid: number;
      changeAmount: number;
      saleDate: Date;
      notes?: string;
      shiftId?: string | null;
    };

  describe('payment validation', () => {
    it('rejects payments that do not cover the total', async () => {
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'card', amount: 15 }]),
        ),
      ).rejects.toThrow('Payments (15.00) do not cover the total (20.00)');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects a card payment larger than the total', async () => {
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'card', amount: 25 }]),
        ),
      ).rejects.toThrow('Only cash payments can exceed the total');
    });

    it('only gives change out of the cash part of a split payment', async () => {
      // 7.00 change but only 2.00 was paid in cash
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([
            { paymentMethodId: 'cash', amount: 2 },
            { paymentMethodId: 'card', amount: 25 },
          ]),
        ),
      ).rejects.toThrow('Only cash payments can exceed the total');
    });

    it('records cash change on a split payment', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([
          { paymentMethodId: 'card', amount: 10 },
          { paymentMethodId: 'cash', amount: 20 },
        ]),
      );
      expect(savedSale()).toMatchObject({
        total: 20,
        amountPaid: 30,
        changeAmount: 10,
      });
    });

    it('accepts an exact non-cash payment with no change', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'card', amount: 20 }]),
      );
      expect(savedSale()).toMatchObject({ amountPaid: 20, changeAmount: 0 });
    });

    it('rejects unknown or inactive payment methods', async () => {
      for (const paymentMethodId of ['missing', 'old']) {
        await expect(
          service.create(
            TENANT,
            USER,
            saleDto([{ paymentMethodId, amount: 20 }]),
          ),
        ).rejects.toThrow('Payment method not found or inactive');
      }
    });

    it('requires a reference where the method asks for one', async () => {
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'cheque', amount: 20 }]),
        ),
      ).rejects.toThrow('cheque payments need a reference');
    });
  });

  describe('create', () => {
    it('numbers the sale and takes the items out of stock', async () => {
      const sale = await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }]),
      );
      expect(sale.id).toBe('sale-1');
      expect(savedSale().saleNumber).toBe('MAIN-000042');
      expect(inventoryService.applyMovement).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          variantId: variant.id,
          locationId: register.defaultLocationId,
          delta: -2,
          allowOversell: false,
          referenceNumber: 'MAIN-000042',
        }),
      );
    });

    it('accepts offline sales even if stock goes negative, dated when rung up', async () => {
      const capturedAt = '2026-09-01T10:00:00.000Z';
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
          offlineCapturedAt: capturedAt,
        }),
        undefined,
        OFFLINE(),
      );
      expect(savedSale().saleDate).toEqual(new Date(capturedAt));
      expect(savedSale().notes).toBe('Recorded offline');
      // Counted in the shift that was open when it was rung up, not today's
      expect(savedSale().shiftId).toBe('shift-at-capture');
      expect(shiftsService.getOpenShift).not.toHaveBeenCalled();
      expect(inventoryService.applyMovement).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ allowOversell: true }),
      );
    });

    it('rejects an inactive register before touching payments', async () => {
      repo(Register).findOne.mockResolvedValue({
        ...register,
        status: RegisterStatus.INACTIVE,
      });
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'cash', amount: 20 }]),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(repo(PaymentMethod).find).not.toHaveBeenCalled();
    });
  });

  describe('idempotency', () => {
    it('returns the existing sale for a repeated key without charging again', async () => {
      saleRepository.findOne.mockResolvedValue({ id: 'existing-sale' });
      const sale = await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
          idempotencyKey: 'key-1',
        }),
      );
      expect(sale.id).toBe('existing-sale');
      expect(saleRepository.findOne).toHaveBeenCalledWith({
        where: { tenantId: TENANT, idempotencyKey: 'key-1' },
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(inventoryService.applyMovement).not.toHaveBeenCalled();
    });

    it('returns the winner when two submissions with the same key race', async () => {
      const duplicate = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_sale_idempotency',
      });
      dataSource.transaction.mockRejectedValueOnce(
        new QueryFailedError('INSERT ...', [], duplicate),
      );
      saleRepository.findOneOrFail.mockResolvedValue({ id: 'winner' });

      const sale = await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
          idempotencyKey: 'key-1',
        }),
      );
      expect(sale.id).toBe('winner');
    });

    it('does not swallow other unique violations', async () => {
      const duplicate = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_sale_number',
      });
      dataSource.transaction.mockRejectedValueOnce(
        new QueryFailedError('INSERT ...', [], duplicate),
      );
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
            idempotencyKey: 'key-1',
          }),
        ),
      ).rejects.toThrow(QueryFailedError);
    });
  });

  describe('cost of goods', () => {
    it('stores the costed unit cost returned by the stock movement', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }]),
      );
      const items = manager.save.mock.calls[1][0] as { cost: number }[];
      expect(items[0].cost).toBe(3.5);
    });
  });

  describe('discount and price authorisation', () => {
    it('refuses a line discount above the store limit without override', async () => {
      const error = await service
        .create(
          TENANT,
          CASHIER,
          saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
            items: [
              {
                variantId: variant.id,
                quantity: 2,
                discountPercent: 50,
                discountReason: 'Damaged box',
              },
            ],
          }),
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        missingPermissions: ['pos.discount.override'],
        approvable: true,
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('accepts it with a manager approval and audits who approved', async () => {
      approvalsService.verify.mockResolvedValue('manager-1' as never);
      await service.create(
        TENANT,
        CASHIER,
        saleDto([{ paymentMethodId: 'cash', amount: 10 }], {
          items: [
            {
              variantId: variant.id,
              quantity: 2,
              discountPercent: 50,
              discountReason: 'Damaged box',
            },
          ],
        }),
        'approval-token',
      );
      expect(approvalsService.verify).toHaveBeenCalledWith(
        'approval-token',
        'pos.discount.override',
        CASHIER,
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sale.discount_override',
          approverId: 'manager-1',
        }),
        manager,
      );
    });

    it('treats a fixed cart discount by its equivalent percentage', async () => {
      // 5.00 off 20.00 = 25% > 20%
      await expect(
        service.quote(TENANT, CASHIER, {
          registerId: register.id,
          items: [{ variantId: variant.id, quantity: 2 }],
          cartDiscount: { type: 'fixed', value: 5, reason: 'Loyal customer' },
        }),
      ).rejects.toThrow("Discounts above 20% need a manager's approval");
      await expect(
        service.quote(TENANT, CASHIER, {
          registerId: register.id,
          items: [{ variantId: variant.id, quantity: 2 }],
          cartDiscount: { type: 'fixed', value: 4 },
        }),
      ).resolves.toMatchObject({ total: 16 });
    });

    it('requires pos.price.override to sell below the catalog price', async () => {
      await expect(
        service.quote(TENANT, CASHIER, {
          registerId: register.id,
          items: [{ variantId: variant.id, quantity: 1, unitPrice: 7 }],
        }),
      ).rejects.toThrow(ForbiddenException);

      const quote = await service.quote(TENANT, USER, {
        registerId: register.id,
        items: [{ variantId: variant.id, quantity: 1, unitPrice: 7 }],
      });
      expect(quote.lines[0]).toMatchObject({ unitPrice: 7, catalogPrice: 10 });
      expect(quote.overrides).toEqual(['pos.price.override']);
    });

    it('records the catalog price and audits a price override', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 14 }], {
          items: [{ variantId: variant.id, quantity: 2, unitPrice: 7 }],
        }),
      );
      const items = manager.save.mock.calls[1][0] as {
        unitPrice: number;
        originalUnitPrice: number | null;
      }[];
      expect(items[0]).toMatchObject({ unitPrice: 7, originalUnitPrice: 10 });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'sale.price_override' }),
        manager,
      );
    });

    it('does not block offline sales that were already rung up', async () => {
      await service.create(
        TENANT,
        CASHIER,
        saleDto([{ paymentMethodId: 'cash', amount: 10 }], {
          items: [{ variantId: variant.id, quantity: 2, discountPercent: 50 }],
          offlineCapturedAt: '2026-09-01T10:00:00.000Z',
          offlineNumber: 'OFFLINE-ABCD1234',
        }),
        undefined,
        OFFLINE(),
      );
      expect(savedSale()).toMatchObject({ offlineNumber: 'OFFLINE-ABCD1234' });
    });
  });

  describe('shifts', () => {
    it('requires an open shift when the store says so', async () => {
      settingsService.getSettings.mockResolvedValue({
        ...settings,
        requireOpenShift: true,
      });
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'cash', amount: 20 }]),
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('stamps the open shift on the sale', async () => {
      shiftsService.getOpenShift.mockResolvedValue({ id: 'shift-1' });
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }]),
      );
      expect(savedSale()).toMatchObject({ shiftId: 'shift-1' });
    });
  });

  describe('card payments through a provider', () => {
    it('waits in payment_pending with stock reserved, then starts the payment', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'terminal', amount: 20 }], {
          idempotencyKey: 'sale-key',
        }),
      );
      expect(savedSale()).toMatchObject({
        status: SaleStatus.PAYMENT_PENDING,
        saleNumber: 'P-000042',
      });
      expect(inventoryService.applyMovement).not.toHaveBeenCalled();
      expect(inventoryService.reserve).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ quantity: 2, referenceType: 'sale' }),
      );
      const payments = manager.save.mock.calls[2][0] as {
        status: PaymentStatus;
        idempotencyKey: string;
        provider: string;
      }[];
      expect(payments[0]).toMatchObject({
        status: PaymentStatus.INITIATED,
        provider: 'mock',
        idempotencyKey: 'sale-key:p1',
      });
      expect(paymentsService.startPayments).toHaveBeenCalledWith(
        TENANT,
        'sale-1',
      );
    });

    it('keeps cash-only sales completing at once', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }]),
      );
      expect(savedSale().saleNumber).toBe('MAIN-000042');
      expect(paymentsService.startPayments).not.toHaveBeenCalled();
    });
  });

  describe('held carts', () => {
    const heldCart = () =>
      ({
        id: 'held-1',
        tenantId: TENANT,
        saleNumber: 'H-000007',
        status: SaleStatus.DRAFT,
        metadata: { cart: {} },
      }) as unknown as SaleEntity;

    it('reserves the stock of a held cart until it expires', async () => {
      await service.hold(TENANT, USER, {
        registerId: register.id,
        items: [{ variantId: variant.id, quantity: 2 }],
      });
      expect(savedSale()).toMatchObject({
        status: SaleStatus.HELD,
        saleNumber: 'H-000042',
      });
      const reserve = inventoryService.reserve.mock.calls[0] as unknown as [
        unknown,
        { expiresAt: Date; quantity: number },
      ];
      expect(reserve[1].quantity).toBe(2);
      const hours = (reserve[1].expiresAt.getTime() - Date.now()) / 3_600_000;
      expect(hours).toBeGreaterThan(23.9);
      expect(inventoryService.applyMovement).not.toHaveBeenCalled();
    });

    it('releases the reservation before selling a resumed cart', async () => {
      manager.findOne.mockResolvedValueOnce(heldCart());
      manager.query.mockReset();
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('document_sequences') ? [[{ lastValue: '42' }], 1] : [],
        ),
      );
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
          heldSaleId: 'held-1',
        }),
      );
      const releaseOrder =
        inventoryService.releaseReservations.mock.invocationCallOrder[0];
      const moveOrder =
        inventoryService.applyMovement.mock.invocationCallOrder[0];
      expect(releaseOrder).toBeLessThan(moveOrder);
      expect(manager.delete).toHaveBeenCalled();
      expect(savedSale()).toMatchObject({
        id: 'held-1',
        status: SaleStatus.COMPLETED,
        saleNumber: 'MAIN-000042',
      });
    });

    it('stores and audits the confirmation of a repriced cart (AC05)', async () => {
      manager.findOne.mockResolvedValueOnce(heldCart());
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
          heldSaleId: 'held-1',
          repricedConfirmedAt: '2026-09-25T10:00:00.000Z',
          repricedPreviousTotal: 18,
        }),
      );
      expect(savedSale()).toMatchObject({
        metadata: expect.objectContaining({
          repricing: {
            confirmedAt: '2026-09-25T10:00:00.000Z',
            confirmedBy: USER.id,
            previousTotal: 18,
            total: 20,
          },
        }) as unknown,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'sale.repricing_confirmed',
          entityId: 'held-1',
          metadata: expect.objectContaining({
            confirmedAt: '2026-09-25T10:00:00.000Z',
            previousTotal: 18,
            total: 20,
            heldSaleId: 'held-1',
          }) as unknown,
        }),
        manager,
      );
    });

    it('records no repricing when none was confirmed', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }]),
      );
      const { metadata } = savedSale() as unknown as {
        metadata: Record<string, unknown>;
      };
      expect(metadata.repricing).toBeUndefined();
      expect(audit.record).not.toHaveBeenCalledWith(
        expect.objectContaining({ action: 'sale.repricing_confirmed' }),
        expect.anything(),
      );
    });

    it('refuses to sell a cart that is no longer open', async () => {
      manager.findOne.mockResolvedValueOnce({
        ...heldCart(),
        status: SaleStatus.CANCELLED,
      });
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
            heldSaleId: 'held-1',
          }),
        ),
      ).rejects.toThrow('This cart is already cancelled');
    });
  });

  describe('payment_pending completion and cancellation', () => {
    const pendingSale = (metadata: Record<string, unknown> = {}) =>
      ({
        id: 'sale-9',
        tenantId: TENANT,
        registerId: register.id,
        userId: USER.id,
        saleNumber: 'P-000003',
        status: SaleStatus.PAYMENT_PENDING,
        total: 20,
        metadata,
      }) as unknown as SaleEntity;

    beforeEach(() => {
      manager.query.mockReset();
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('document_sequences')
            ? [[{ lastValue: '11' }], 1]
            : [{ max: 10 }],
        ),
      );
    });

    it('completes once every payment is captured', async () => {
      manager.findOne.mockResolvedValueOnce(pendingSale());
      manager.find
        .mockResolvedValueOnce([{ status: PaymentStatus.CAPTURED }])
        .mockResolvedValueOnce([
          { id: 'item-1', variantId: 'var-1', quantity: 2 },
        ]);
      manager.findOneOrFail
        .mockResolvedValueOnce(register)
        .mockResolvedValueOnce(branch);
      await service.completePendingSale(TENANT, 'sale-9');
      expect(inventoryService.releaseReservations).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ referenceId: 'sale-9', status: 'committed' }),
      );
      expect(inventoryService.applyMovement).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ delta: -2, allowOversell: true }),
      );
      expect(manager.update).toHaveBeenCalledWith(
        SaleEntity,
        { id: 'sale-9', tenantId: TENANT },
        expect.objectContaining({
          status: SaleStatus.COMPLETED,
          saleNumber: 'MAIN-000011',
        }),
      );
    });

    it('does not complete a sale that is being cancelled at the till', async () => {
      manager.findOne.mockResolvedValueOnce(
        pendingSale({ cancellingAt: new Date().toISOString() }),
      );
      await service.completePendingSale(TENANT, 'sale-9');
      expect(manager.find).not.toHaveBeenCalled();
      expect(manager.update).not.toHaveBeenCalled();
    });

    it('waits while a payment is still open', async () => {
      manager.findOne.mockResolvedValueOnce(pendingSale());
      manager.find.mockResolvedValueOnce([{ status: PaymentStatus.PENDING }]);
      await service.completePendingSale(TENANT, 'sale-9');
      expect(inventoryService.applyMovement).not.toHaveBeenCalled();
    });

    it('refuses to cancel when the sale completed in the meantime', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValueOnce(pendingSale());
      // The flag update matched no payment_pending row
      (dataSource as unknown as { query: jest.Mock }).query = jest.fn(() =>
        Promise.resolve([[], 0]),
      );
      await expect(service.cancel(TENANT, 'sale-9')).rejects.toThrow(
        'completed in the meantime',
      );
      expect(paymentsService.cancelSalePayments).not.toHaveBeenCalled();
    });
  });

  describe('revoked devices', () => {
    const DEVICE = '11111111-2222-4333-8444-555555555555';
    const revokedAt = new Date('2026-09-10T12:00:00.000Z');

    beforeEach(() => {
      repo(Device).findOne.mockResolvedValue({ id: DEVICE, revokedAt });
    });

    it('refuses sales from a revoked till and audits the attempt', async () => {
      await expect(
        requestContext.run({ deviceId: DEVICE }, () =>
          service.create(
            TENANT,
            USER,
            saleDto([{ paymentMethodId: 'cash', amount: 20 }]),
          ),
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'sale.revoked_device_rejected' }),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses offline sales rung up after the revocation', async () => {
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
            offlineCapturedAt: '2026-09-11T09:00:00.000Z',
          }),
          undefined,
          OFFLINE(DEVICE),
        ),
      ).rejects.toThrow('revoked');
    });

    it('accepts offline sales rung up before the revocation, on record', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
          deviceSequence: 4,
          offlineCapturedAt: '2026-09-09T09:00:00.000Z',
        }),
        undefined,
        OFFLINE(DEVICE),
      );
      expect(savedSale()).toMatchObject({
        deviceId: DEVICE,
        deviceSequence: 4,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'sale.revoked_device_accepted' }),
        manager,
      );
    });

    it('ignores devices that are not revoked', async () => {
      repo(Device).findOne.mockResolvedValue({ id: DEVICE, revokedAt: null });
      await requestContext.run({ deviceId: DEVICE }, () =>
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'cash', amount: 20 }]),
        ),
      );
      expect(savedSale()).toMatchObject({ deviceId: DEVICE });
    });

    it('uses the till the request comes from, never a device id in the body', async () => {
      repo(Device).findOne.mockResolvedValue({ id: DEVICE, revokedAt: null });
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
          deviceId: DEVICE,
        }),
      );
      expect(savedSale()).toMatchObject({ deviceId: null });
      expect(repo(Device).findOne).not.toHaveBeenCalled();
    });
  });

  describe('discount code usage limits', () => {
    // 10% off the cart: 20.00 → 18.00
    const code = (extra: Record<string, unknown> = {}) => ({
      id: 'disc-1',
      tenantId: TENANT,
      code: 'ONCE',
      discountType: DiscountType.PERCENTAGE,
      scope: DiscountScope.CART,
      percentage: 10,
      usageLimit: 1,
      usageCount: 0,
      usageLimitPerCustomer: null,
      applicableProductIds: [],
      applicableCategoryIds: [],
      excludedProductIds: [],
      ...extra,
    });
    const customer = { id: 'cust-1', tenantId: TENANT, status: 'active' };
    let usesLeft: number;
    let customerUses: number;
    const sqlCalls = (fragment: string) =>
      (manager.query.mock.calls as [string, unknown[]?][]).filter(([sql]) =>
        sql.includes(fragment),
      );

    beforeEach(() => {
      usesLeft = 1;
      customerUses = 0;
      manager.query.mockReset();
      manager.query.mockImplementation((sql: string) => {
        if (sql.includes('"usageCount" < "usageLimit"')) {
          // The guarded UPDATE: a row back only while a use is left
          return Promise.resolve(
            usesLeft-- > 0 ? [[{ id: 'disc-1' }], 1] : [[], 0],
          );
        }
        if (sql.includes('COUNT(*)')) {
          return Promise.resolve([{ used: customerUses }]);
        }
        if (sql.includes('document_sequences')) {
          return Promise.resolve([[{ lastValue: '42' }], 1]);
        }
        return Promise.resolve([{ max: 41 }]);
      });
      discountsService.findUsableByCode.mockResolvedValue(code());
      repo(Customer).findOne.mockResolvedValue(customer);
    });

    const cardSale = (extra: Partial<CreateSaleDto> = {}) =>
      saleDto([{ paymentMethodId: 'terminal', amount: 18 }], {
        discountCode: 'ONCE',
        ...extra,
      });

    it('takes the use at checkout for a sale waiting on a card, with the limit enforced', async () => {
      await service.create(TENANT, USER, cardSale());
      expect(savedSale()).toMatchObject({
        status: SaleStatus.PAYMENT_PENDING,
        total: 18,
        metadata: expect.objectContaining({
          discountId: 'disc-1',
          discountConsumed: true,
        }) as unknown,
      });
      expect(sqlCalls('"usageCount" < "usageLimit"')).toHaveLength(1);
    });

    it('refuses the last use to a second card sale (no over-use while payments are pending)', async () => {
      await service.create(TENANT, USER, cardSale());
      paymentsService.startPayments.mockClear();
      // Checked before the transaction on stale data: only the UPDATE catches it
      await expect(service.create(TENANT, USER, cardSale())).rejects.toThrow(
        'This discount has reached its usage limit',
      );
      expect(paymentsService.startPayments).not.toHaveBeenCalled();
    });

    it('enforces the limit for a completed sale too', async () => {
      usesLeft = 0;
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'cash', amount: 18 }], {
            discountCode: 'ONCE',
          }),
        ),
      ).rejects.toThrow('This discount has reached its usage limit');
    });

    it('refuses a code limited per customer without a customer, or once used up', async () => {
      discountsService.findUsableByCode.mockResolvedValue(
        code({ usageLimit: null, usageLimitPerCustomer: 1 }),
      );
      const quote = (customerId?: string) =>
        service.quote(TENANT, USER, {
          registerId: register.id,
          customerId,
          discountCode: 'ONCE',
          items: [{ variantId: variant.id, quantity: 2 }],
        });
      await expect(quote()).rejects.toThrow('limited per customer');
      customerUses = 1;
      await expect(quote('cust-1')).rejects.toThrow(
        'This customer has already used this discount',
      );
      customerUses = 0;
      await expect(quote('cust-1')).resolves.toMatchObject({ total: 18 });
    });

    it('re-checks the per-customer limit under the discount lock, not counting the sale itself', async () => {
      discountsService.findUsableByCode.mockResolvedValue(
        code({ usageLimit: null, usageLimitPerCustomer: 2 }),
      );
      await service.create(TENANT, USER, cardSale({ customerId: 'cust-1' }));
      const counts = sqlCalls('COUNT(*)');
      // At preparation, then inside the transaction after the guarded UPDATE
      expect(counts).toHaveLength(2);
      expect(counts[1][1]).toEqual([TENANT, 'cust-1', 'disc-1', 'sale-1']);
    });

    describe('when the card sale ends', () => {
      const pendingSale = (metadata: Record<string, unknown>) =>
        ({
          id: 'sale-9',
          tenantId: TENANT,
          registerId: register.id,
          userId: USER.id,
          saleNumber: 'P-000003',
          status: SaleStatus.PAYMENT_PENDING,
          total: 18,
          metadata,
        }) as unknown as SaleEntity;

      const complete = async (metadata: Record<string, unknown>) => {
        manager.findOne.mockResolvedValueOnce(pendingSale(metadata));
        manager.find
          .mockResolvedValueOnce([{ status: PaymentStatus.CAPTURED }])
          .mockResolvedValueOnce([]);
        manager.findOneOrFail
          .mockResolvedValueOnce(register)
          .mockResolvedValueOnce(branch);
        await service.completePendingSale(TENANT, 'sale-9');
      };

      it('does not count the use a second time on completion', async () => {
        await complete({ discountId: 'disc-1', discountConsumed: true });
        expect(sqlCalls('UPDATE discounts')).toHaveLength(0);
        expect(manager.update).toHaveBeenCalledWith(
          SaleEntity,
          { id: 'sale-9', tenantId: TENANT },
          expect.objectContaining({ status: SaleStatus.COMPLETED }),
        );
      });

      it('counts it on completion for a sale started before uses were taken at checkout', async () => {
        await complete({ discountId: 'disc-1' });
        expect(sqlCalls('UPDATE discounts')).toHaveLength(1);
        // The card is already charged: no limit check
        expect(sqlCalls('"usageLimit"')).toHaveLength(0);
      });

      const cancel = async (metadata: Record<string, unknown>) => {
        jest.spyOn(service, 'findOne').mockResolvedValueOnce(pendingSale({}));
        dataSource.query.mockResolvedValue([[{ id: 'sale-9' }], 1]);
        manager.findOne.mockResolvedValueOnce(pendingSale(metadata));
        await service.cancel(TENANT, 'sale-9');
      };

      it('gives the use back when it is cancelled, and clears the flag', async () => {
        await cancel({ discountId: 'disc-1', discountConsumed: true });
        const released = sqlCalls('GREATEST("usageCount" - 1, 0)');
        expect(released).toHaveLength(1);
        expect(released[0][1]).toEqual(['disc-1', TENANT]);
        const update = manager.update.mock.calls.find(
          ([entity]) => entity === SaleEntity,
        ) as [unknown, unknown, { status: SaleStatus; metadata: () => string }];
        expect(update[2].status).toBe(SaleStatus.CANCELLED);
        expect(update[2].metadata()).toContain('"discountConsumed": false');
      });

      it('gives nothing back when no use was taken for the sale', async () => {
        await cancel({ discountId: 'disc-1' });
        expect(sqlCalls('UPDATE discounts')).toHaveLength(0);
      });
    });
  });

  describe('idempotency key reuse', () => {
    const dto = (extra: Partial<CreateSaleDto> = {}) =>
      saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
        idempotencyKey: 'key-1',
        ...extra,
      });
    const recorded = (request: CreateSaleDto) => ({
      id: 'existing-sale',
      metadata: { requestHash: SalesService.requestHash(request) },
    });

    it('stores a fingerprint of the request on the new sale', async () => {
      await service.create(TENANT, USER, dto());
      expect(savedSale()).toMatchObject({
        metadata: expect.objectContaining({
          requestHash: SalesService.requestHash(dto()),
        }) as unknown,
      });
    });

    it('returns the same sale when the identical request is replayed', async () => {
      saleRepository.findOne.mockResolvedValue(recorded(dto()));
      const sale = await service.create(TENANT, USER, dto());
      expect(sale.id).toBe('existing-sale');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses the key for a different cart with 409', async () => {
      saleRepository.findOne.mockResolvedValue(recorded(dto()));
      const error = await service
        .create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'cash', amount: 30 }], {
            idempotencyKey: 'key-1',
            items: [{ variantId: variant.id, quantity: 3 }],
          }),
        )
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getStatus()).toBe(409);
      expect((error as Error).message).toBe(
        'This idempotency key was already used for a different sale',
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('also refuses it when the race is lost to a different cart', async () => {
      const duplicate = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_sale_idempotency',
      });
      dataSource.transaction.mockRejectedValueOnce(
        new QueryFailedError('INSERT ...', [], duplicate),
      );
      saleRepository.findOneOrFail.mockResolvedValue(
        recorded(dto({ customerId: 'someone-else' })),
      );
      await expect(service.create(TENANT, USER, dto())).rejects.toThrow(
        ConflictException,
      );
    });

    it('matches the offline copy the till queues after a lost response', async () => {
      // Online attempt: catalog prices, held cart and estimate by reference
      const online = dto({
        customerId: 'cust-1',
        heldSaleId: 'held-1',
        estimateId: 'est-1',
        discountCode: 'once',
      });
      // Offline copy of the same checkout, as the POS stores and syncs it
      const offline = dto({
        customerId: 'cust-1',
        discountCode: 'once',
        items: [{ variantId: variant.id, quantity: 2, unitPrice: 10 }],
        offlineCapturedAt: '2026-09-01T10:00:00.000Z',
        offlineNumber: 'OFFLINE-ABCD1234',
        deviceId: '11111111-2222-4333-8444-555555555555',
        deviceSequence: 7,
      });
      expect(SalesService.requestHash(offline)).toBe(
        SalesService.requestHash(online),
      );
      saleRepository.findOne.mockResolvedValue(recorded(online));
      await expect(service.create(TENANT, USER, offline)).resolves.toEqual({
        id: 'existing-sale',
      });
    });

    it('returns sales recorded before fingerprints existed as before', async () => {
      saleRepository.findOne.mockResolvedValue({
        id: 'existing-sale',
        metadata: {},
      });
      const sale = await service.create(
        TENANT,
        USER,
        dto({ items: [{ variantId: variant.id, quantity: 5 }] }),
      );
      expect(sale.id).toBe('existing-sale');
    });
  });

  describe('per-branch numbering (D017)', () => {
    it('numbers a completed sale in its branch sequence, under a lock per tenant + branch prefix', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }]),
      );
      expect(savedSale().saleNumber).toBe('MAIN-000042');
      // One update of the branch's counter row, in the sale's transaction (its
      // row lock queues concurrent sales of the branch until commit)
      const [counterCall] = manager.query.mock.calls as [string, unknown[]][];
      expect(counterCall[0]).toContain('UPDATE document_sequences');
      expect(counterCall[1]).toEqual([TENANT, 'sales:saleNumber:MAIN']);
    });

    it('gives an offline sale the branch number on sync and keeps its OFFLINE number', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
          offlineCapturedAt: '2026-09-01T10:00:00.000Z',
          offlineNumber: 'OFFLINE-ABCD1234',
        }),
        undefined,
        OFFLINE(),
      );
      expect(savedSale()).toMatchObject({
        saleNumber: 'MAIN-000042',
        offlineNumber: 'OFFLINE-ABCD1234',
      });
    });
  });

  describe('receipt snapshot', () => {
    const storeSettings = {
      ...settings,
      storeName: 'Chez Marie',
      businessLegalName: 'Marie SA',
      businessTaxId: 'NIF-1',
      receiptFooter: 'Merci !',
      receiptFormat: '58mm',
      receiptTemplate: 'compact',
      returnPolicy: '7 days',
    };

    it('freezes the seller identity on a completed sale', async () => {
      settingsService.getSettings.mockResolvedValue(storeSettings);
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }]),
      );
      expect(savedSale()).toMatchObject({
        documentSnapshot: expect.objectContaining({
          storeName: 'Chez Marie',
          businessLegalName: 'Marie SA',
          businessTaxId: 'NIF-1',
          receiptFooter: 'Merci !',
          receiptFormat: '58mm',
          receiptTemplate: 'compact',
          returnPolicy: '7 days',
          branch: expect.objectContaining({
            name: 'Main street',
            phone: '509-1111',
          }) as unknown,
        }) as unknown,
      });
    });

    it('leaves it for the completion of a sale waiting on a card', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'terminal', amount: 20 }]),
      );
      expect(savedSale()).toMatchObject({ documentSnapshot: null });
    });

    it('takes it when the card payment completes', async () => {
      manager.query.mockReset();
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('document_sequences')
            ? [[{ lastValue: '4' }], 1]
            : [{ max: 3 }],
        ),
      );
      settingsService.getSettings.mockResolvedValue(storeSettings);
      manager.findOne.mockResolvedValueOnce({
        id: 'sale-9',
        tenantId: TENANT,
        registerId: register.id,
        branchId: branch.id,
        saleNumber: 'P-000003',
        status: SaleStatus.PAYMENT_PENDING,
        total: 20,
        metadata: {},
      });
      manager.find
        .mockResolvedValueOnce([{ status: PaymentStatus.CAPTURED }])
        .mockResolvedValueOnce([]);
      manager.findOneOrFail
        .mockResolvedValueOnce(register)
        .mockResolvedValueOnce(branch);
      await service.completePendingSale(TENANT, 'sale-9');
      expect(manager.update).toHaveBeenCalledWith(
        SaleEntity,
        { id: 'sale-9', tenantId: TENANT },
        expect.objectContaining({
          saleNumber: 'MAIN-000004',
          documentSnapshot: expect.objectContaining({
            storeName: 'Chez Marie',
          }) as unknown,
        }),
      );
    });

    it('does not rewrite a sale when it is reprinted', async () => {
      saleRepository.findOne.mockResolvedValue({
        id: 'sale-1',
        saleNumber: 'MAIN-000001',
        status: SaleStatus.COMPLETED,
        receiptPrintCount: 0,
        documentSnapshot: { storeName: 'Old name' },
      });
      manager.query.mockReset();
      manager.query.mockResolvedValue([[{ receiptPrintCount: 1 }], 1]);
      const result = await service.reprint(TENANT, 'sale-1');
      expect(result.receiptPrintCount).toBe(1);
      // Only the print counter changes; the snapshot stays as printed
      const updates = (manager.query.mock.calls as [string][]).map(
        ([sql]) => sql,
      );
      expect(updates.every((sql) => !sql.includes('documentSnapshot'))).toBe(
        true,
      );
      expect(manager.update).not.toHaveBeenCalled();
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  describe('no negative stock (D018)', () => {
    it('refuses an online sale beyond the stock, even for a backorder product', async () => {
      repo(ProductVariant).find.mockResolvedValue([
        { ...variant, product: { ...variant.product, allowBackorder: true } },
      ]);
      inventoryService.applyMovement.mockRejectedValueOnce(
        new BadRequestException('Not enough stock (1 available)'),
      );
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'cash', amount: 20 }]),
        ),
      ).rejects.toThrow('Not enough stock (1 available)');
      expect(inventoryService.applyMovement).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ allowOversell: false }),
      );
    });

    it('reserves a card sale only if the stock is there', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'terminal', amount: 20 }]),
      );
      expect(inventoryService.reserve).toHaveBeenCalledWith(
        manager,
        expect.not.objectContaining({ allowOversell: true }),
      );
    });

    const offlineSale = () =>
      saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
        offlineCapturedAt: '2026-09-01T10:00:00.000Z',
        offlineNumber: 'OFFLINE-ABCD1234',
        deviceId: '11111111-2222-4333-8444-555555555555',
      });
    const savedCases = () =>
      (manager.save.mock.calls as [Record<string, unknown>][])
        .map(([row]) => row)
        .filter((row) => !Array.isArray(row) && 'type' in row);

    it('records an offline oversell and opens a review case', async () => {
      // 2 sold, 1 was on the shelf: the location is now at -1
      inventoryService.applyMovement.mockResolvedValueOnce({
        unitCost: 3.5,
        quantityOnHand: -1,
        quantityReserved: 0,
      } as never);
      await service.create(
        TENANT,
        USER,
        offlineSale(),
        undefined,
        OFFLINE('11111111-2222-4333-8444-555555555555'),
      );
      expect(inventoryService.applyMovement).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ allowOversell: true, delta: -2 }),
      );
      expect(savedCases()).toEqual([
        expect.objectContaining({
          type: 'offline_oversell',
          status: 'open',
          saleId: 'sale-1',
          deviceId: '11111111-2222-4333-8444-555555555555',
          details: expect.objectContaining({
            saleNumber: 'MAIN-000042',
            offlineNumber: 'OFFLINE-ABCD1234',
            lines: [
              expect.objectContaining({
                variantId: variant.id,
                quantity: 2,
                shortBy: 1,
              }),
            ],
          }) as unknown,
        }),
      ]);
    });

    it('opens no case when the offline sale was covered by the stock', async () => {
      inventoryService.applyMovement.mockResolvedValueOnce({
        unitCost: 3.5,
        quantityOnHand: 3,
        quantityReserved: 1,
      } as never);
      await service.create(
        TENANT,
        USER,
        offlineSale(),
        undefined,
        OFFLINE('11111111-2222-4333-8444-555555555555'),
      );
      expect(savedCases()).toEqual([]);
    });

    it('flags offline discounts the cashier could not give without a manager', async () => {
      await service.create(
        TENANT,
        CASHIER,
        {
          ...offlineSale(),
          items: [{ variantId: variant.id, quantity: 2, discountPercent: 50 }],
          payments: [{ paymentMethodId: 'cash', amount: 10 }],
        },
        undefined,
        OFFLINE(),
      );
      expect(savedCases()).toEqual([
        expect.objectContaining({
          type: 'offline_price',
          details: expect.objectContaining({
            missingPermissions: ['pos.discount.override'],
          }) as unknown,
        }),
      ]);
    });
    it("records an uploaded sale under the till's cashier and checks their permissions", async () => {
      // A manager uploads it; the cashier who rang it up could not give 50%
      await service.create(
        TENANT,
        USER,
        {
          ...offlineSale(),
          items: [{ variantId: variant.id, quantity: 2, discountPercent: 50 }],
          payments: [{ paymentMethodId: 'cash', amount: 10 }],
        },
        undefined,
        {
          actingUser: { id: CASHIER.id, permissions: CASHIER.permissions },
          ...OFFLINE(),
        },
      );
      expect(savedSale()).toMatchObject({
        userId: CASHIER.id,
        metadata: expect.objectContaining({ uploadedBy: USER.id }) as unknown,
      });
      expect(savedCases()).toEqual([
        expect.objectContaining({
          type: 'offline_price',
          details: expect.objectContaining({
            cashierId: CASHIER.id,
            uploadedBy: USER.id,
            missingPermissions: ['pos.discount.override'],
          }) as unknown,
        }),
      ]);
    });
  });

  describe('measured items (sold by weight)', () => {
    const apples = {
      ...variant,
      id: 'var-kg',
      sku: 'APPLES',
      price: 3.99,
      product: {
        ...variant.product,
        name: { en: 'Apples' },
        unit: { code: 'kg', allowsDecimals: true, precision: 3 },
      },
    };

    beforeEach(() => {
      repo(ProductVariant).find.mockResolvedValue([apples]);
    });

    it('sells 1.250 kg by the kg and keeps the unit on the line', async () => {
      await service.create(TENANT, USER, {
        registerId: register.id,
        items: [{ variantId: apples.id, quantity: 1.25 }],
        // Cash: anything above the total is change
        payments: [{ paymentMethodId: 'cash', amount: 100 }],
      });
      const items = manager.save.mock.calls[1][0] as {
        quantity: number;
        subtotal: number;
        metadata: Record<string, unknown>;
      }[];
      // The mocked price list sells everything at 10.00: 1.25 kg × 10 = 12.50
      expect(items[0]).toMatchObject({ quantity: 1.25, subtotal: 12.5 });
      expect(items[0].metadata).toMatchObject({ unit: 'kg', unitPrecision: 3 });
      expect(inventoryService.applyMovement).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ variantId: apples.id, delta: -1.25 }),
      );
    });

    it('keeps two weighings of the same item as two lines', async () => {
      await service.create(TENANT, USER, {
        registerId: register.id,
        items: [
          { variantId: apples.id, quantity: 1.25 },
          { variantId: apples.id, quantity: 0.5 },
        ],
        payments: [{ paymentMethodId: 'cash', amount: 100 }],
      });
      const items = manager.save.mock.calls[1][0] as { quantity: number }[];
      expect(items.map((i) => i.quantity)).toEqual([1.25, 0.5]);
    });

    it('refuses decimals for an item sold by the piece', async () => {
      repo(ProductVariant).find.mockResolvedValue([variant]);
      await expect(
        service.quote(TENANT, USER, {
          registerId: register.id,
          items: [{ variantId: variant.id, quantity: 1.5 }],
        }),
      ).rejects.toThrow('SKU-1: Quantity must be a whole number');
    });

    it('refuses more decimals than the unit precision', async () => {
      await expect(
        service.quote(TENANT, USER, {
          registerId: register.id,
          items: [{ variantId: apples.id, quantity: 1.2505 }],
        }),
      ).rejects.toThrow('APPLES: Quantity can have at most 3 decimals (kg)');
    });
  });

  describe('services and other non-stock items', () => {
    const service_ = {
      ...variant,
      id: 'var-svc',
      sku: 'REPAIR',
      product: { ...variant.product, isStockTracked: false },
    };

    beforeEach(() => {
      repo(ProductVariant).find.mockResolvedValue([service_]);
    });

    it('sells them without touching stock', async () => {
      await service.create(TENANT, USER, {
        registerId: register.id,
        items: [{ variantId: service_.id, quantity: 2 }],
        payments: [{ paymentMethodId: 'cash', amount: 20 }],
      });
      expect(inventoryService.applyMovement).not.toHaveBeenCalled();
      const items = manager.save.mock.calls[1][0] as {
        metadata: Record<string, unknown>;
      }[];
      expect(items[0].metadata).toMatchObject({ stockTracked: false });
    });

    it('neither reserves them for a held cart nor a card payment', async () => {
      await service.hold(TENANT, USER, {
        registerId: register.id,
        items: [{ variantId: service_.id, quantity: 1 }],
      });
      await service.create(TENANT, USER, {
        registerId: register.id,
        items: [{ variantId: service_.id, quantity: 2 }],
        payments: [{ paymentMethodId: 'terminal', amount: 20 }],
      });
      expect(inventoryService.reserve).not.toHaveBeenCalled();
    });

    it('does not put them back in stock when the sale is voided', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue({
        id: 'sale-1',
        tenantId: TENANT,
        registerId: register.id,
        saleNumber: 'MAIN-000001',
        status: SaleStatus.COMPLETED,
        total: 20,
        items: [
          {
            variantId: 'var-svc',
            quantity: 1,
            metadata: { stockTracked: false },
          },
          { variantId: 'var-1', quantity: 2, metadata: {} },
        ],
      } as unknown as Sale);
      repo(Register).findOneOrFail.mockResolvedValue(register);
      manager.update.mockResolvedValue({ affected: 1 });
      await service.void(TENANT, USER, 'sale-1', 'Mistake');
      expect(inventoryService.applyMovement).toHaveBeenCalledTimes(1);
      expect(inventoryService.applyMovement).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ variantId: 'var-1', delta: 2 }),
      );
    });

    it('skips them when a card sale completes', async () => {
      manager.query.mockReset();
      manager.query.mockResolvedValue([{ max: 0 }]);
      manager.findOne.mockResolvedValueOnce({
        id: 'sale-9',
        tenantId: TENANT,
        registerId: register.id,
        branchId: branch.id,
        saleNumber: 'P-000003',
        status: SaleStatus.PAYMENT_PENDING,
        total: 20,
        metadata: {},
      });
      manager.find
        .mockResolvedValueOnce([{ status: PaymentStatus.CAPTURED }])
        .mockResolvedValueOnce([
          {
            id: 'i1',
            variantId: 'var-svc',
            quantity: 1,
            metadata: { stockTracked: false },
          },
        ]);
      manager.findOneOrFail
        .mockResolvedValueOnce(register)
        .mockResolvedValueOnce(branch);
      await service.completePendingSale(TENANT, 'sale-9');
      expect(inventoryService.applyMovement).not.toHaveBeenCalled();
    });
  });

  describe('salesperson', () => {
    const SELLER = '99999999-2222-4333-8444-555555555555';
    const membership = (extra: Record<string, unknown> = {}) => ({
      tenantId: TENANT,
      userId: SELLER,
      role: 'cashier',
      status: 'active',
      user: { firstName: 'Rose', lastName: 'Paul', status: 'active' },
      ...extra,
    });
    const membersAre = (rows: unknown[]) =>
      manager.find.mockImplementation(((entity: { name?: string }) =>
        Promise.resolve(
          entity?.name === 'TenantMembership' ? rows : [],
        )) as never);

    afterEach(() => {
      manager.find.mockImplementation(() => Promise.resolve([]));
      (manager as unknown as { count?: jest.Mock }).count = undefined;
    });

    it('credits the sale to an active member who sells', async () => {
      membersAre([membership()]);
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
          salespersonId: SELLER,
        }),
      );
      expect(savedSale()).toMatchObject({
        salespersonId: SELLER,
        userId: USER.id,
      });
      expect(manager.find).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          where: expect.objectContaining({
            tenantId: TENANT,
            userId: SELLER,
            status: 'active',
          }) as unknown,
        }),
      );
    });

    it('refuses someone who is not an active member of the store', async () => {
      for (const rows of [
        [],
        [membership({ user: { status: 'inactive' } })],
        // A role that can neither sell nor write estimates
        [membership({ role: 'nobody' })],
      ]) {
        membersAre(rows);
        await expect(
          service.create(
            TENANT,
            USER,
            saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
              salespersonId: SELLER,
            }),
          ),
        ).rejects.toThrow('The salesperson must be an active member');
      }
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('drops an unknown salesperson from an offline sale instead of refusing it', async () => {
      membersAre([]);
      (manager as unknown as { count: jest.Mock }).count = jest.fn(() =>
        Promise.resolve(0),
      );
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
          salespersonId: SELLER,
          offlineCapturedAt: '2026-09-01T10:00:00.000Z',
        }),
        undefined,
        OFFLINE(),
      );
      expect(savedSale()).toMatchObject({ salespersonId: null });
    });
  });

  describe('zero-value sales', () => {
    // 100% off: total 0.00, nothing to pay
    const freeSale = (extra: Partial<CreateSaleDto> = {}) =>
      saleDto([], {
        items: [
          {
            variantId: variant.id,
            quantity: 2,
            discountPercent: 100,
            discountReason: 'Replacement under warranty',
          },
        ],
        ...extra,
      });

    it('are refused unless the store allows them', async () => {
      await expect(service.create(TENANT, USER, freeSale())).rejects.toThrow(
        'This store does not allow sales with a total of 0.00',
      );
    });

    it('complete without payment for a user with pos.discount.override', async () => {
      settingsService.getSettings.mockResolvedValue({
        ...settings,
        allowZeroValueSales: true,
      } as never);
      await service.create(TENANT, USER, freeSale());
      expect(savedSale()).toMatchObject({
        total: 0,
        amountPaid: 0,
        status: SaleStatus.COMPLETED,
      });
      expect(manager.save.mock.calls[2][0]).toEqual([]);
    });

    it("need a manager's approval otherwise", async () => {
      settingsService.getSettings.mockResolvedValue({
        ...settings,
        maxDiscountPercent: 100,
        allowZeroValueSales: true,
      } as never);
      const error = await service
        .create(TENANT, CASHIER, freeSale())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        missingPermissions: ['pos.discount.override'],
        approvable: true,
      });
    });

    it('still need payments when the total is not zero', async () => {
      await expect(service.create(TENANT, USER, saleDto([]))).rejects.toThrow(
        'Payments (0.00) do not cover the total (20.00)',
      );
    });
  });

  describe('discount reasons and line notes', () => {
    it('requires a reason for a line discount above the store limit', async () => {
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'cash', amount: 10 }], {
            items: [
              { variantId: variant.id, quantity: 2, discountPercent: 50 },
            ],
          }),
        ),
      ).rejects.toThrow('Give a reason for the discount on line 1 (above 20%)');
    });

    it('requires one for a cart discount above the limit, not below it', async () => {
      const quote = (reason?: string, value = 50) =>
        service.quote(TENANT, USER, {
          registerId: register.id,
          items: [{ variantId: variant.id, quantity: 2 }],
          cartDiscount: { type: 'percentage', value, reason },
        });
      await expect(quote()).rejects.toThrow(
        'Give a reason for the discount on the sale',
      );
      await expect(quote('Staff purchase')).resolves.toMatchObject({
        total: 10,
      });
      await expect(quote(undefined, 10)).resolves.toMatchObject({ total: 18 });
    });

    it('keeps the reasons and notes on the sale', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 9 }], {
          items: [
            {
              variantId: variant.id,
              quantity: 2,
              discountPercent: 50,
              discountReason: ' Damaged box ',
              note: 'Gift wrapped',
            },
          ],
          cartDiscount: { type: 'fixed', value: 1, reason: 'Rounding' },
        }),
      );
      expect(savedSale()).toMatchObject({
        metadata: expect.objectContaining({
          cartDiscountReason: 'Rounding',
        }) as unknown,
      });
      const items = manager.save.mock.calls[1][0] as {
        notes: string;
        metadata: Record<string, unknown>;
      }[];
      expect(items[0]).toMatchObject({
        notes: 'Gift wrapped',
        metadata: { discountPercent: 50, discountReason: 'Damaged box' },
      });
    });
  });
  // Numbering, loyalty and the rest of the SQL a checkout runs, by statement
  const answerQueries = () => {
    manager.query.mockReset();
    manager.query.mockImplementation(((sql: string) =>
      Promise.resolve(
        sql.includes('MAX(')
          ? [{ max: 41 }]
          : sql.includes('notEarning')
            ? [{ notEarning: '0' }]
            : [],
      )) as never);
  };

  describe('on account, gift cards and store credit', () => {
    const special = [
      method('onacct', PaymentMethodType.ON_ACCOUNT, { code: 'ON_ACCOUNT' }),
      method('gift', PaymentMethodType.GIFT_CARD, { code: 'GIFT_CARD' }),
    ];
    const customer = {
      id: 'cust-1',
      tenantId: TENANT,
      status: 'active',
      creditHold: false,
    };
    const SELLER = {
      id: 'seller-1',
      tenantId: TENANT,
      role: 'cashier',
      permissions: ['pos.sell', 'customers.credit.sell'],
    } as unknown as AuthUser;

    beforeEach(() => {
      answerQueries();
      repo(PaymentMethod).find.mockResolvedValue([...methods, ...special]);
      repo(Customer).findOne.mockResolvedValue(customer);
      customerCredit.checkCharge.mockResolvedValue({
        exceedsLimit: false,
        available: 100,
      });
    });

    const onAccount = (extra: Partial<CreateSaleDto> = {}) =>
      saleDto([{ paymentMethodId: 'onacct', amount: 20 }], {
        customerId: 'cust-1',
        ...extra,
      });

    it('needs a customer', async () => {
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'onacct', amount: 20 }]),
        ),
      ).rejects.toThrow('Choose the customer to sell on account');
    });

    it('posts the charge in the sale transaction', async () => {
      await service.create(TENANT, USER, onAccount());
      expect(customerCredit.chargeSale).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          customerId: 'cust-1',
          saleId: 'sale-1',
          amount: 20,
          allowOverLimit: false,
        }),
      );
    });

    it("needs customers.credit.sell or a manager's approval", async () => {
      await expect(
        service.create(TENANT, CASHIER, onAccount()),
      ).rejects.toMatchObject({
        response: {
          missingPermissions: ['customers.credit.sell'],
          approvable: true,
        },
      });
      expect(customerCredit.chargeSale).not.toHaveBeenCalled();

      approvalsService.verify.mockImplementation(((
        _token: string,
        permission: string,
      ) =>
        Promise.resolve(
          permission === 'customers.credit.sell' ? 'manager-1' : null,
        )) as never);
      await service.create(TENANT, CASHIER, onAccount(), 'token-1');
      expect(customerCredit.chargeSale).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ approverId: 'manager-1' }),
      );
    });

    it('needs customers.credit.override (or an approval) to exceed the credit limit', async () => {
      customerCredit.checkCharge.mockResolvedValue({
        exceedsLimit: true,
        available: 5,
      });
      await expect(
        service.create(TENANT, SELLER, onAccount()),
      ).rejects.toMatchObject({
        response: { missingPermissions: ['customers.credit.override'] },
      });

      approvalsService.verify.mockImplementation(((
        _token: string,
        permission: string,
      ) =>
        Promise.resolve(
          permission === 'customers.credit.override' ? 'manager-1' : null,
        )) as never);
      await service.create(TENANT, SELLER, onAccount(), 'token-1');
      expect(customerCredit.chargeSale).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          allowOverLimit: true,
          approverId: 'manager-1',
        }),
      );
    });

    it('is refused while the customer is on credit hold', async () => {
      repo(Customer).findOne.mockResolvedValue({
        ...customer,
        creditHold: true,
      });
      await expect(service.create(TENANT, USER, onAccount())).rejects.toThrow(
        'credit hold',
      );
    });

    it('is not accepted offline', async () => {
      await expect(
        service.create(
          TENANT,
          USER,
          onAccount({ offlineCapturedAt: '2026-09-01T10:00:00.000Z' }),
          undefined,
          OFFLINE(),
        ),
      ).rejects.toThrow("can't be used offline");
    });

    it('redeems a gift card by its code, keeping only the last 4 on the payment', async () => {
      storedValue.findGiftCardByCode.mockResolvedValue({
        id: 'acc-1',
        accountType: 'gift_card',
        status: 'active',
        balance: 50,
        last4: '6789',
        expiresAt: null,
      });
      await service.create(
        TENANT,
        USER,
        saleDto([
          {
            paymentMethodId: 'gift',
            amount: 20,
            giftCardCode: 'ABCD-EFGH-2345-6789',
          },
        ]),
      );
      expect(storedValue.redeem).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          accountId: 'acc-1',
          amount: 20,
          saleId: 'sale-1',
        }),
      );
      const payments = manager.save.mock.calls
        .map((c) => c[0] as unknown)
        .find(
          (d): d is object[] =>
            Array.isArray(d) &&
            d.length > 0 &&
            'paymentMethodId' in (d[0] as object),
        );
      expect(payments?.[0]).toMatchObject({ reference: '****6789' });
      expect(JSON.stringify(payments)).not.toContain('EFGH');
    });

    it('refuses more than the gift card holds', async () => {
      storedValue.findGiftCardByCode.mockResolvedValue({
        id: 'acc-1',
        accountType: 'gift_card',
        status: 'active',
        balance: 10,
        last4: '6789',
        expiresAt: null,
      });
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([
            { paymentMethodId: 'gift', amount: 20, giftCardCode: 'X1234567' },
          ]),
        ),
      ).rejects.toThrow('balance is not enough');
      expect(storedValue.redeem).not.toHaveBeenCalled();
    });

    it.each([
      ['unknown', null],
      [
        'not active yet',
        { id: 'a', accountType: 'gift_card', status: 'pending', balance: 50 },
      ],
      [
        'expired',
        {
          id: 'a',
          accountType: 'gift_card',
          status: 'active',
          balance: 50,
          expiresAt: new Date(Date.now() - 1000),
        },
      ],
    ])('gives one answer for a card that is %s', async (_case, account) => {
      storedValue.findGiftCardByCode.mockResolvedValue(account);
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([
            { paymentMethodId: 'gift', amount: 20, giftCardCode: 'X1234567' },
          ]),
        ),
      ).rejects.toThrow("This gift card can't be used");
    });

    it('sells a gift card as an untaxed, undiscounted stored value line', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'var-gc',
        productId: 'prod-gc',
        sku: 'SYS-GIFT-CARD',
        name: null,
        product: { name: { en: 'Gift card' }, isStockTracked: false },
      });
      storedValue.createSaleGiftCards.mockResolvedValue([
        {
          accountId: 'acc-9',
          code: 'AAAA-BBBB-CCCC-DDDD',
          last4: 'DDDD',
          amount: 25,
        },
      ] as never);
      const sale = await service.create(TENANT, USER, {
        registerId: register.id,
        items: [],
        giftCards: [{ amount: 25 }],
        payments: [{ paymentMethodId: 'cash', amount: 25 }],
      });
      expect(savedSale().total).toBe(25);
      const items = manager.save.mock.calls
        .map((c) => c[0] as unknown)
        .find(
          (d): d is { metadata: object; taxAmount: number }[] =>
            Array.isArray(d) && d.length > 0 && 'variantId' in (d[0] as object),
        );
      expect(items?.[0]).toMatchObject({
        taxAmount: 0,
        metadata: { storedValue: true, stockTracked: false },
      });
      expect(inventoryService.applyMovement).not.toHaveBeenCalled();
      expect(storedValue.createSaleGiftCards).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          activate: true,
          cards: [expect.objectContaining({ amount: 25 })],
        }),
      );
      expect(sale.issuedGiftCards?.[0].code).toBe('AAAA-BBBB-CCCC-DDDD');
    });
  });

  describe('domain events', () => {
    beforeEach(answerQueries);
    it('records sale.completed with the sale transaction manager', async () => {
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }]),
      );
      expect(outbox.record).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          type: 'sale.completed',
          aggregateId: 'sale-1',
          payload: expect.objectContaining({
            total: 20,
            lines: [{ variantId: 'var-1', locationId: 'loc-1', quantity: 2 }],
          }) as unknown,
        }),
      );
    });

    it('voids: sale.voided, account charge reversed, stored value given back', async () => {
      jest.spyOn(service, 'findOne').mockResolvedValue({
        id: 'sale-1',
        tenantId: TENANT,
        registerId: register.id,
        saleNumber: 'MAIN-000001',
        status: SaleStatus.COMPLETED,
        total: 20,
        items: [],
      } as unknown as Sale);
      repo(Register).findOneOrFail.mockResolvedValue(register);
      manager.update.mockResolvedValue({ affected: 1 });
      await service.void(TENANT, USER, 'sale-1', 'Mistake');
      expect(customerCredit.reverseSale).toHaveBeenCalledWith(
        manager,
        TENANT,
        'sale-1',
        'Void MAIN-000001',
      );
      expect(storedValue.reverseSaleRedemptions).toHaveBeenCalledWith(
        manager,
        TENANT,
        'sale-1',
        'Void MAIN-000001',
      );
      expect(storedValue.voidSaleGiftCards).toHaveBeenCalled();
      expect(outbox.record).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          type: 'sale.voided',
          payload: {
            saleId: 'sale-1',
            saleNumber: 'MAIN-000001',
            reason: 'Mistake',
          },
        }),
      );
    });
  });

  describe('offline fields (only from the till upload)', () => {
    const casesSaved = () =>
      (manager.save.mock.calls as [Record<string, unknown>][])
        .map(([row]) => row)
        .filter((row) => !Array.isArray(row) && 'type' in row);

    it.each([
      ['offlineCapturedAt', { offlineCapturedAt: '2026-09-01T10:00:00.000Z' }],
      ['offlineNumber', { offlineNumber: 'OFFLINE-ABCD1234' }],
      ['deviceSequence', { deviceSequence: 3 }],
    ])('refuses %s on POST /sales', async (_field, extra) => {
      await expect(
        service.create(
          TENANT,
          CASHIER,
          saleDto([{ paymentMethodId: 'cash', amount: 10 }], {
            items: [{ variantId: variant.id, quantity: 2, unitPrice: 5 }],
            ...extra,
          }),
        ),
      ).rejects.toThrow('POST /sync/push');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses an uploaded sale captured in the future', async () => {
      await expect(
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
            offlineCapturedAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
          undefined,
          OFFLINE(),
        ),
      ).rejects.toThrow('in the future');
    });

    describe('foreign currency taken offline', () => {
      beforeEach(() => {
        settingsService.getSettings.mockImplementation(() =>
          Promise.resolve({
            ...settings,
            currencyCode: 'USD',
            exchangeRates: { HTG: 132.5 },
          } as never),
        );
      });
      const htg = (tenderedAmount: number, exchangeRate: number) =>
        saleDto([
          {
            paymentMethodId: 'cash',
            amount: 20,
            currencyCode: 'HTG',
            tenderedAmount,
            exchangeRate,
          },
        ]);

      it("ignores the client's rate online", async () => {
        // 1000 HTG at a forged rate of 50 would be 20.00; at 132.5 it is 7.55
        await expect(
          service.create(TENANT, USER, htg(1000, 50)),
        ).rejects.toThrow('do not cover the total');
      });

      it("keeps the till's rate within 10% of the store's, for review", async () => {
        await service.create(
          TENANT,
          USER,
          { ...htg(2400, 120), offlineCapturedAt: '2026-09-01T10:00:00.000Z' },
          undefined,
          OFFLINE(),
        );
        const payments = manager.save.mock.calls.find(
          ([rows]) =>
            Array.isArray(rows) &&
            (rows as { tenderedCurrency?: string }[])[0]?.tenderedCurrency,
        )![0] as { exchangeRate: number; amount: number }[];
        expect(payments[0]).toMatchObject({ exchangeRate: 120, amount: 20 });
        expect(casesSaved()).toEqual([
          expect.objectContaining({
            type: 'offline_price',
            details: expect.objectContaining({
              exchangeRates: [
                {
                  currencyCode: 'HTG',
                  tillRate: 120,
                  storeRate: 132.5,
                  appliedRate: 120,
                },
              ],
            }) as unknown,
          }),
        ]);
      });

      it("uses the store's rate when the till's is too far off", async () => {
        await expect(
          service.create(
            TENANT,
            USER,
            { ...htg(1000, 50), offlineCapturedAt: '2026-09-01T10:00:00.000Z' },
            undefined,
            OFFLINE(),
          ),
        ).rejects.toThrow('do not cover the total');
        await service.create(
          TENANT,
          USER,
          { ...htg(2650, 50), offlineCapturedAt: '2026-09-01T10:00:00.000Z' },
          undefined,
          OFFLINE(),
        );
        expect(savedSale()).toMatchObject({ amountPaid: 20, changeAmount: 0 });
      });

      it("never gives back more change than was paid at the store's rate", async () => {
        // 2650 HTG is 20.00 at 132.5; at the till's 120 it would leave 2.08 change
        await expect(
          service.create(
            TENANT,
            USER,
            {
              ...htg(2650, 120),
              offlineCapturedAt: '2026-09-01T10:00:00.000Z',
            },
            undefined,
            OFFLINE(),
          ),
        ).rejects.toThrow("more than what was paid at the store's");
      });

      it('refuses a currency the store does not accept, offline too', async () => {
        await expect(
          service.create(
            TENANT,
            USER,
            {
              ...saleDto([
                {
                  paymentMethodId: 'cash',
                  amount: 20,
                  currencyCode: 'EUR',
                  tenderedAmount: 20,
                  exchangeRate: 1,
                },
              ]),
              offlineCapturedAt: '2026-09-01T10:00:00.000Z',
            },
            undefined,
            OFFLINE(),
          ),
        ).rejects.toThrow('EUR is not accepted');
      });
    });

    describe('shift of an uploaded sale', () => {
      const noShiftAtCapture = () =>
        repo(Shift).createQueryBuilder.mockImplementationOnce(() => {
          const qb = {
            select: () => qb,
            where: () => qb,
            andWhere: () => qb,
            orderBy: () => qb,
            limit: () => qb,
            getRawOne: () => Promise.resolve(undefined),
          };
          return qb;
        });
      const upload = () =>
        service.create(
          TENANT,
          USER,
          saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
            offlineCapturedAt: '2026-09-01T10:00:00.000Z',
          }),
          undefined,
          OFFLINE(),
        );

      it('goes to the open shift when none was open at capture', async () => {
        noShiftAtCapture();
        shiftsService.getOpenShift.mockResolvedValue({ id: 'shift-now' });
        await upload();
        expect(savedSale().shiftId).toBe('shift-now');
        expect(casesSaved()).toEqual([]);
      });

      it('opens a review case when no shift is open then or now', async () => {
        noShiftAtCapture();
        await upload();
        expect(savedSale().shiftId).toBeNull();
        expect(casesSaved()).toEqual([
          expect.objectContaining({
            type: 'offline_no_shift',
            details: expect.objectContaining({
              cashPaid: 20,
              total: 20,
            }) as unknown,
          }),
        ]);
      });
    });
  });

  describe('chosen price lists', () => {
    beforeEach(() => {
      // The wholesale list prices the coffee at 6.00, the catalog at 10.00
      pricingService.resolvePrices.mockImplementation(((
        _tenantId: string,
        variants: { id: string }[],
        context: { priceListId?: string },
      ) =>
        Promise.resolve(
          new Map(variants.map((v) => [v.id, context.priceListId ? 6 : 10])),
        )) as never);
    });
    afterEach(() => {
      pricingService.resolvePrices.mockImplementation(
        (_tenantId: string, variants: { id: string }[]) =>
          Promise.resolve(new Map(variants.map((v) => [v.id, 10]))),
      );
    });
    const wholesale = (payment: number) =>
      saleDto([{ paymentMethodId: 'cash', amount: payment }], {
        priceListId: '99999999-2222-4333-8444-555555555555',
      });

    it("treats a list the customer isn't entitled to as a price change", async () => {
      pricingService.needsPriceOverride.mockResolvedValueOnce(true);
      await expect(
        service.create(TENANT, CASHIER, wholesale(12)),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          missingPermissions: ['pos.price.override'],
        }) as unknown,
      });
    });

    it('sells at the list price with pos.price.override, on record', async () => {
      pricingService.needsPriceOverride.mockResolvedValueOnce(true);
      await service.create(TENANT, USER, wholesale(12));
      expect(savedSale().total).toBe(12);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'sale.price_override' }),
        manager,
      );
    });

    it("applies the customer's group list (or an automatic list) freely", async () => {
      pricingService.needsPriceOverride.mockResolvedValueOnce(false);
      await service.create(TENANT, CASHIER, wholesale(12));
      expect(savedSale().total).toBe(12);
      expect(pricingService.resolvePrices).toHaveBeenCalledTimes(1);
    });
  });

  describe('selling an estimate', () => {
    const estimateLines = (customerId: string | null) =>
      estimatesService.quotedLines.mockResolvedValue({
        estimate: {
          id: 'est-1',
          estimateNumber: 'EST-7',
          customerId,
          cartDiscount: null,
        },
        lines: new Map([
          [variant.id, { unitPrice: 8, discountPercent: 0, quantity: 2 }],
        ]),
      });
    const sell = (
      user: AuthUser,
      items: CreateSaleDto['items'],
      amount: number,
      extra: Partial<CreateSaleDto> = {},
    ) =>
      service.create(
        TENANT,
        user,
        saleDto([{ paymentMethodId: 'cash', amount }], {
          estimateId: '77777777-2222-4333-8444-555555555555',
          items,
          ...extra,
        }),
      );

    it('sells the quoted quantity at the quoted price without approval', async () => {
      estimateLines(null);
      await sell(
        CASHIER,
        [{ variantId: variant.id, quantity: 2, unitPrice: 8 }],
        16,
      );
      expect(savedSale().total).toBe(16);
      expect(estimatesService.lockOpen).toHaveBeenCalledWith(
        manager,
        TENANT,
        '77777777-2222-4333-8444-555555555555',
      );
      expect(estimatesService.markConverted).toHaveBeenCalled();
    });

    it('prices units beyond the quoted quantity at the catalog price', async () => {
      estimateLines(null);
      // 3 at the quoted 8.00: the line goes past the 2 quoted, so it is a price change
      await expect(
        sell(
          CASHIER,
          [{ variantId: variant.id, quantity: 3, unitPrice: 8 }],
          24,
        ),
      ).rejects.toThrow(ForbiddenException);
      // Split: the quoted 2 at 8.00, the extra one at the catalog 10.00
      await sell(
        CASHIER,
        [
          { variantId: variant.id, quantity: 2, unitPrice: 8 },
          { variantId: variant.id, quantity: 1 },
        ],
        26,
      );
      expect(savedSale().total).toBe(26);
    });

    it("is only for the estimate's customer", async () => {
      estimateLines('cust-1');
      await expect(
        sell(
          CASHIER,
          [{ variantId: variant.id, quantity: 2, unitPrice: 8 }],
          16,
        ),
      ).rejects.toThrow('EST-7 is for another customer');
    });

    it('fails when another sale converted the estimate first', async () => {
      estimateLines(null);
      estimatesService.lockOpen.mockRejectedValueOnce(
        new ConflictException('Estimate EST-7 is converted'),
      );
      await expect(
        sell(
          CASHIER,
          [{ variantId: variant.id, quantity: 2, unitPrice: 8 }],
          16,
        ),
      ).rejects.toThrow('converted');
    });
  });

  describe('held carts of other branches', () => {
    it('does not find a cart of a branch the user may not work in', async () => {
      manager.findOne.mockResolvedValueOnce({
        id: 'held-2',
        tenantId: TENANT,
        branchId: 'branch-2',
        status: SaleStatus.HELD,
      });
      await expect(
        requestContext.run({ userId: 'u', branchIds: ['branch-1'] }, () =>
          service.create(
            TENANT,
            USER,
            saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
              heldSaleId: 'held-2',
            }),
          ),
        ),
      ).rejects.toThrow('Held cart not found');
    });
  });

  describe('voids', () => {
    const completed = (extra: Record<string, unknown> = {}) =>
      jest.spyOn(service, 'findOne').mockResolvedValue({
        id: 'sale-1',
        tenantId: TENANT,
        registerId: register.id,
        saleNumber: 'MAIN-000001',
        status: SaleStatus.COMPLETED,
        saleDate: new Date(),
        total: 20,
        items: [],
        payments: [],
        ...extra,
      } as unknown as Sale);
    beforeEach(() => {
      repo(Register).findOneOrFail.mockResolvedValue(register);
      manager.update.mockResolvedValue({ affected: 1 });
      repo(Shift).findOne.mockResolvedValue({
        id: 'shift-1',
        status: 'open',
        closedAt: null,
      });
    });

    it('voids a sale of the open shift', async () => {
      completed({ shiftId: 'shift-1' });
      await service.void(TENANT, USER, 'sale-1', 'Mistake');
      expect(manager.update).toHaveBeenCalledWith(
        SaleEntity,
        expect.objectContaining({ id: 'sale-1' }),
        expect.objectContaining({ status: SaleStatus.VOIDED }),
      );
    });

    it('refuses once the shift is closed', async () => {
      completed({ shiftId: 'shift-1' });
      repo(Shift).findOne.mockResolvedValue({
        id: 'shift-1',
        status: 'closed',
        closedAt: new Date(),
      });
      await expect(
        service.void(TENANT, USER, 'sale-1', 'Mistake'),
      ).rejects.toThrow('use a return');
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('refuses a sale without a shift after a day', async () => {
      completed({ shiftId: null, saleDate: new Date(Date.now() - 25 * 3.6e6) });
      await expect(
        service.void(TENANT, USER, 'sale-1', 'Mistake'),
      ).rejects.toThrow('more than a day old');
    });

    it('refuses a sale paid through a card terminal', async () => {
      completed({
        payments: [
          { status: PaymentStatus.CAPTURED, provider: 'mock', amount: 20 },
        ],
      });
      await expect(
        service.void(TENANT, USER, 'sale-1', 'Mistake'),
      ).rejects.toThrow('payment terminal');
    });

    it('marks a manual card payment refunded', async () => {
      completed({
        payments: [
          { status: PaymentStatus.COMPLETED, provider: 'manual', amount: 20 },
        ],
      });
      await service.void(TENANT, USER, 'sale-1', 'Mistake');
      expect(manager.update).toHaveBeenCalledWith(
        expect.anything(),
        { saleId: 'sale-1', tenantId: TENANT },
        { status: PaymentStatus.REFUNDED },
      );
    });

    it('refuses a sale that already has a return or goodwill refund', async () => {
      completed();
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(sql.includes('sale_returns') ? [{ id: 'ret-1' }] : []),
      );
      await expect(
        service.void(TENANT, USER, 'sale-1', 'Mistake'),
      ).rejects.toThrow('already has a return');
      expect(manager.update).not.toHaveBeenCalled();
    });
  });

  describe('loyalty points', () => {
    it('are earned on merchandise paid with money only', async () => {
      repo(Customer).findOne.mockResolvedValue({
        id: 'cust-1',
        tenantId: TENANT,
        status: 'active',
      });
      manager.query.mockImplementation((sql: string) =>
        Promise.resolve(
          sql.includes('document_sequences')
            ? [[{ lastValue: '42' }], 1]
            : sql.includes('notEarning')
              ? [{ notEarning: '15' }]
              : [],
        ),
      );
      await service.create(
        TENANT,
        USER,
        saleDto([{ paymentMethodId: 'cash', amount: 20 }], {
          customerId: 'cust-1',
        }),
      );
      const [sql, params] = (manager.query.mock.calls as [string, unknown[]][])
        .filter(([q]) => q.includes('notEarning'))
        .at(0)!;
      expect(sql).toContain("metadata->>'giftCard'");
      expect(params[1]).toEqual(
        expect.arrayContaining([
          'LOYALTY',
          'GIFT_CARD',
          'STORE_CREDIT',
          'EXCHANGE_CREDIT',
          'ON_ACCOUNT',
        ]),
      );
      expect(loyaltyService.earn).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ amountPaid: 5 }),
      );
    });
  });
});
