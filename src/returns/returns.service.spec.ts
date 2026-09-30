import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { Sale, SaleStatus } from '../database/entities/sale.entity';
import { SaleItem } from '../database/entities/sale-item.entity';
import { Payment, PaymentStatus } from '../database/entities/payment.entity';
import {
  PaymentMethod,
  PaymentMethodStatus,
  PaymentMethodType,
} from '../database/entities/payment-method.entity';
import { Register, RegisterStatus } from '../database/entities/register.entity';
import { SaleReturn } from '../database/entities/sale-return.entity';
import {
  ExchangeLink,
  ExchangeStatus,
} from '../database/entities/exchange-link.entity';
import { ReturnDisposition } from '../database/entities/sale-return-item.entity';
import {
  RefundStatus,
  SaleReturnRefund,
} from '../database/entities/sale-return-refund.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { ALL_PERMISSIONS, Permission } from '../auth/permissions';
import { SettingsService } from '../settings/settings.service';
import { InventoryService } from '../inventory/inventory.service';
import { ShiftsService } from '../shifts/shifts.service';
import { AuditService } from '../audit/audit.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { PaymentProviderRegistry } from '../payments/providers/provider-registry';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { CreateReturnDto } from './returns.dto';
import { ReturnsService } from './returns.service';
import { CustomerCreditService } from '../customers/credit/customer-credit.service';
import { StoredValueService } from '../stored-value/stored-value.service';
import { OutboxService } from '../platform/outbox/outbox.service';

const TENANT = 'tenant-1';
const OWNER = {
  id: 'user-1',
  tenantId: TENANT,
  role: 'owner',
  permissions: ALL_PERMISSIONS,
} as unknown as AuthUser;
// Can refund, but only back to the original payments
const CLERK = {
  id: 'clerk-1',
  tenantId: TENANT,
  role: 'custom',
  permissions: ['sales.view', 'sales.refund'],
} as unknown as AuthUser;

// Two coffees at 10.00, no tax, paid 20.00 by card (no provider: refunded on the spot)
const sale = {
  id: 'sale-1',
  tenantId: TENANT,
  saleNumber: 'S-000001',
  status: SaleStatus.COMPLETED,
  saleDate: new Date(),
  total: '20.0000',
  changeAmount: '0',
  currencyCode: 'USD',
  customerId: null,
};
const saleItem = {
  id: 'si-1',
  saleId: sale.id,
  variantId: 'var-1',
  sku: 'SKU-1',
  productName: 'Coffee',
  variantName: null,
  quantity: 2,
  unitPrice: '10',
  subtotal: '20',
  discountAmount: '0',
  taxAmount: '0',
  total: '20',
  cost: '4',
};
const register = {
  id: 'reg-1',
  tenantId: TENANT,
  status: RegisterStatus.ACTIVE,
  defaultLocationId: 'loc-1',
};
const method = (id: string, methodType: PaymentMethodType) => ({
  id,
  code: id.toUpperCase(),
  name: { en: id },
  methodType,
  status: PaymentMethodStatus.ACTIVE,
  provider: null,
});
const methods = [
  method('card', PaymentMethodType.CARD),
  method('cash', PaymentMethodType.CASH),
];
const cardPayment = {
  id: 'pay-card',
  saleId: sale.id,
  paymentMethodId: 'card',
  amount: '20',
  status: PaymentStatus.COMPLETED,
  provider: null,
  providerReference: null,
  paymentMethod: methods[0],
};

const returnDto = (extra: Partial<CreateReturnDto> = {}): CreateReturnDto => ({
  saleId: sale.id,
  registerId: register.id,
  reason: 'Changed mind',
  idempotencyKey: 'return-key-1',
  items: [
    {
      saleItemId: saleItem.id,
      quantity: 1,
      disposition: ReturnDisposition.RESTOCK,
    },
  ],
  ...extra,
});

interface StoredRefund {
  returnId: string;
  originalPaymentId: string | null;
  amount: number;
  status: RefundStatus;
}

describe('ReturnsService', () => {
  let service: ReturnsService;
  // Refunds already recorded against the sale, and units already returned
  let storedRefunds: StoredRefund[];
  let returnedUnits: number;
  let payments: unknown[];

  // Query builder stand-in: sums stored refunds per payment, honouring the
  // "status != failed" filter only if the service asks for it
  const queryBuilder = (entity: unknown) => {
    const filters: { sql: string; params?: Record<string, unknown> }[] = [];
    const qb = {
      innerJoin: () => qb,
      select: () => qb,
      addSelect: () => qb,
      groupBy: () => qb,
      where: (sql: string, params?: Record<string, unknown>) => {
        filters.push({ sql, params });
        return qb;
      },
      andWhere: (sql: string, params?: Record<string, unknown>) => {
        filters.push({ sql, params });
        return qb;
      },
      getRawMany: () => {
        if (entity !== SaleReturnRefund) {
          return Promise.resolve(
            returnedUnits
              ? [{ saleItemId: saleItem.id, quantity: String(returnedUnits) }]
              : [],
          );
        }
        const excluded = filters.find((f) =>
          f.sql.includes('refund.status != :failed'),
        )?.params?.failed;
        const totals = new Map<string | null, number>();
        for (const r of storedRefunds) {
          if (excluded && r.status === excluded) continue;
          totals.set(
            r.originalPaymentId,
            (totals.get(r.originalPaymentId) ?? 0) + r.amount,
          );
        }
        return Promise.resolve(
          [...totals].map(([paymentId, amount]) => ({
            paymentId,
            amount: String(amount),
          })),
        );
      },
    };
    return qb;
  };

  const manager = {
    findOne: jest.fn((entity: unknown) =>
      Promise.resolve(
        entity === Sale ? { ...sale } : entity === Register ? register : null,
      ),
    ),
    find: jest.fn((entity: unknown): Promise<unknown[]> => {
      if (entity === SaleItem) return Promise.resolve([saleItem]);
      if (entity === Payment) return Promise.resolve(payments);
      if (entity === PaymentMethod) return Promise.resolve(methods);
      if (entity === SaleReturnRefund)
        return Promise.resolve(
          storedRefunds.filter((r) => r.status === RefundStatus.FAILED),
        );
      return Promise.resolve([]);
    }),
    count: jest.fn(() => Promise.resolve(1)),
    createQueryBuilder: jest.fn((entity: unknown) => queryBuilder(entity)),
    query: jest.fn((sql: string) =>
      Promise.resolve(
        sql.includes('MAX(')
          ? [{ max: 0 }]
          : sql.includes('remaining')
            ? [{ remaining: '1' }]
            : [],
      ),
    ),
    create: jest.fn((_entity: unknown, data: object) => data),
    save: jest.fn((data: object) =>
      Promise.resolve(Array.isArray(data) ? data : { id: 'ret-1', ...data }),
    ),
    update: jest.fn(),
    insert: jest.fn(),
    delete: jest.fn(),
    findOneOrFail: jest.fn(),
    exists: jest.fn(() => Promise.resolve(true)),
    // Special tender methods (store credit, exchange credit), created on first use
    getRepository: jest.fn(() => ({
      findOne: jest.fn(({ where }: { where: { code: string } }) =>
        Promise.resolve({
          id: where.code.toLowerCase(),
          code: where.code,
          name: { en: where.code },
          methodType: PaymentMethodType.OTHER,
          status: PaymentMethodStatus.ACTIVE,
        }),
      ),
    })),
  };
  const refundRepository = {
    find: jest.fn(() => Promise.resolve([])),
    update: jest.fn(),
  };
  const returnRepository = {
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    update: jest.fn(),
  };
  const dataSource = {
    manager,
    getRepository: jest.fn(() => refundRepository),
    transaction: jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager),
    ),
  };
  const approvalsService = {
    verify: jest.fn<Promise<string | null>, [string, Permission]>(),
  };
  const shiftsService = {
    getOpenShift: jest.fn(() => Promise.resolve({ id: 'shift-1' })),
    recordCashMovement: jest.fn(),
  };
  const inventoryService = {
    applyMovement: jest.fn(),
    resolveConditionLocation: jest.fn(() => Promise.resolve('loc-quarantine')),
  };
  const customerCredit = { creditNote: jest.fn() };
  const storedValue = {
    refundTo: jest.fn(),
    storeCreditAccount: jest.fn(() => Promise.resolve({ id: 'sc-1' })),
    voidSaleGiftCards: jest.fn(),
  };
  const outbox = { record: jest.fn() };
  const audit = { record: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    storedRefunds = [];
    returnedUnits = 0;
    payments = [cardPayment];
    returnRepository.findOne.mockResolvedValue(null);
    approvalsService.verify.mockResolvedValue(null);

    const module = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: getRepositoryToken(SaleReturn), useValue: returnRepository },
        { provide: DataSource, useValue: dataSource },
        {
          provide: SettingsService,
          useValue: {
            getSettings: jest.fn(() =>
              Promise.resolve({ returnWindowDays: 30 }),
            ),
          },
        },
        { provide: InventoryService, useValue: inventoryService },
        { provide: ShiftsService, useValue: shiftsService },
        { provide: AuditService, useValue: audit },
        { provide: ApprovalsService, useValue: approvalsService },
        {
          provide: PaymentProviderRegistry,
          useValue: { has: () => false, get: jest.fn() },
        },
        { provide: LoyaltyService, useValue: { onReturn: jest.fn() } },
        { provide: CustomerCreditService, useValue: customerCredit },
        { provide: StoredValueService, useValue: storedValue },
        { provide: OutboxService, useValue: outbox },
      ],
    }).compile();
    service = module.get(ReturnsService);
    // findOne loads the full return through a query builder; not under test here
    jest
      .spyOn(service, 'findOne')
      .mockImplementation((_tenantId, id) =>
        Promise.resolve({ id } as unknown as SaleReturn),
      );
  });

  const savedRefunds = () =>
    manager.save.mock.calls
      .map((call) => call[0] as unknown)
      .find(
        (data): data is { paymentMethodId: string; amount: number }[] =>
          Array.isArray(data) &&
          data.length > 0 &&
          'paymentMethodId' in (data[0] as object),
      );

  describe('idempotency', () => {
    const validateDto = (body: object) =>
      validate(plainToInstance(CreateReturnDto, body));

    it('requires an idempotency key of 8 to 100 characters', async () => {
      const withoutKey: Partial<CreateReturnDto> = returnDto();
      delete withoutKey.idempotencyKey;
      const missing = await validateDto(withoutKey);
      expect(missing.map((e) => e.property)).toContain('idempotencyKey');

      const tooShort = await validateDto(returnDto({ idempotencyKey: 'abc' }));
      expect(tooShort.map((e) => e.property)).toContain('idempotencyKey');

      const valid = await validateDto(
        returnDto({ idempotencyKey: '6f1c2a9e-4b7d-4e3a-9c1f-2d8e5b7a0c31' }),
      );
      expect(valid.map((e) => e.property)).not.toContain('idempotencyKey');
    });

    // The stored return a replayed request is compared against
    const recorded = {
      id: 'ret-original',
      originalSaleId: sale.id,
      registerId: register.id,
      reason: 'Changed mind',
      items: [
        {
          saleItemId: saleItem.id,
          quantity: 1,
          disposition: ReturnDisposition.RESTOCK,
          locationId: 'loc-1',
          reason: null,
        },
      ],
      refunds: [
        {
          paymentMethodId: 'card',
          originalPaymentId: cardPayment.id,
          amount: '10.0000',
        },
      ],
    };

    it('returns the original return when the same request is sent again', async () => {
      returnRepository.findOne.mockResolvedValue({ id: recorded.id });
      jest
        .spyOn(service, 'findOne')
        .mockResolvedValue(recorded as unknown as SaleReturn);

      const result = await service.create(TENANT, OWNER, returnDto());

      expect(result.id).toBe('ret-original');
      expect(returnRepository.findOne).toHaveBeenCalledWith({
        where: { tenantId: TENANT, idempotencyKey: 'return-key-1' },
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(inventoryService.applyMovement).not.toHaveBeenCalled();
    });

    it('rejects the same key with a different request (409)', async () => {
      returnRepository.findOne.mockResolvedValue({ id: recorded.id });
      jest
        .spyOn(service, 'findOne')
        .mockResolvedValue(recorded as unknown as SaleReturn);

      const twoUnits = returnDto({
        items: [
          {
            saleItemId: saleItem.id,
            quantity: 2,
            disposition: ReturnDisposition.RESTOCK,
          },
        ],
      });
      await expect(service.create(TENANT, OWNER, twoUnits)).rejects.toThrow(
        ConflictException,
      );
      // Same lines, but the refund now asked for in cash
      await expect(
        service.create(TENANT, OWNER, returnDto({ refundMethodId: 'cash' })),
      ).rejects.toThrow(ConflictException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('checks the payload when two submissions with the same key race', async () => {
      const duplicate = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_return_idempotency',
      });
      dataSource.transaction.mockRejectedValueOnce(
        new QueryFailedError('INSERT ...', [], duplicate),
      );
      returnRepository.findOneOrFail.mockResolvedValue({ id: recorded.id });
      jest
        .spyOn(service, 'findOne')
        .mockResolvedValue(recorded as unknown as SaleReturn);

      await expect(
        service.create(TENANT, OWNER, returnDto({ reason: 'Faulty' })),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe('refund cap', () => {
    it('does not count a failed refund toward what can still be refunded', async () => {
      // An earlier return of one coffee whose card refund failed
      returnedUnits = 1;
      storedRefunds = [
        {
          returnId: 'ret-failed',
          originalPaymentId: cardPayment.id,
          amount: 10,
          status: RefundStatus.FAILED,
        },
      ];

      await service.create(TENANT, OWNER, returnDto());

      expect(savedRefunds()).toEqual([
        expect.objectContaining({
          paymentMethodId: 'card',
          originalPaymentId: cardPayment.id,
          amount: 10,
        }),
      ]);
    });

    it('still counts the goods of a return whose refund failed', async () => {
      returnedUnits = 1;
      storedRefunds = [
        {
          returnId: 'ret-failed',
          originalPaymentId: cardPayment.id,
          amount: 10,
          status: RefundStatus.FAILED,
        },
      ];
      const twoUnits = returnDto({
        items: [
          {
            saleItemId: saleItem.id,
            quantity: 2,
            disposition: ReturnDisposition.RESTOCK,
          },
        ],
      });
      await expect(service.create(TENANT, OWNER, twoUnits)).rejects.toThrow(
        'Only 1 × Coffee can still be returned',
      );
    });

    it('rejects a refund above what is left after completed and pending refunds', async () => {
      storedRefunds = [
        {
          returnId: 'ret-a',
          originalPaymentId: cardPayment.id,
          amount: 15,
          status: RefundStatus.COMPLETED,
        },
      ];
      await expect(service.create(TENANT, OWNER, returnDto())).rejects.toThrow(
        'This refund would exceed what the customer paid for the sale',
      );
    });

    describe('retrying a failed refund', () => {
      beforeEach(() => {
        jest.spyOn(service, 'findOne').mockResolvedValue({
          id: 'ret-failed',
          originalSaleId: sale.id,
          status: 'refund_failed',
        } as unknown as SaleReturn);
      });

      it('retries when it fits under the cap', async () => {
        storedRefunds = [
          {
            returnId: 'ret-failed',
            originalPaymentId: cardPayment.id,
            amount: 10,
            status: RefundStatus.FAILED,
          },
          {
            returnId: 'ret-b',
            originalPaymentId: cardPayment.id,
            amount: 10,
            status: RefundStatus.COMPLETED,
          },
        ];
        await service.retryRefunds(TENANT, 'ret-failed');
        expect(manager.update).toHaveBeenCalledWith(
          SaleReturnRefund,
          {
            tenantId: TENANT,
            returnId: 'ret-failed',
            status: RefundStatus.FAILED,
          },
          { status: RefundStatus.PENDING, failureReason: null },
        );
      });

      it('refuses a retry that would refund more than the payment took', async () => {
        storedRefunds = [
          {
            returnId: 'ret-failed',
            originalPaymentId: cardPayment.id,
            amount: 10,
            status: RefundStatus.FAILED,
          },
          {
            returnId: 'ret-b',
            originalPaymentId: cardPayment.id,
            amount: 15,
            status: RefundStatus.COMPLETED,
          },
        ];
        await expect(
          service.retryRefunds(TENANT, 'ret-failed'),
        ).rejects.toThrow(ConflictException);
        expect(manager.update).not.toHaveBeenCalled();
      });
    });
  });

  describe('refund to another payment method', () => {
    it('lets the original payment method through without extra permission', async () => {
      await service.create(
        TENANT,
        CLERK,
        returnDto({ refundMethodId: 'card' }),
      );
      expect(approvalsService.verify).not.toHaveBeenCalled();
      expect(savedRefunds()).toHaveLength(1);
    });

    it('needs sales.refund.any_method to refund a card sale in cash', async () => {
      const error = await service
        .create(TENANT, CLERK, returnDto({ refundMethodId: 'cash' }))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as ForbiddenException).getResponse()).toMatchObject({
        missingPermissions: ['sales.refund.any_method'],
        approvable: true,
      });
      expect(savedRefunds()).toBeUndefined();
    });

    it('needs it for more than the original method has left', async () => {
      // Paid 10.00 card + 10.00 cash; 5.00 already went back to the card
      payments = [
        { ...cardPayment, amount: '10' },
        {
          ...cardPayment,
          id: 'pay-cash',
          paymentMethodId: 'cash',
          amount: '10',
          paymentMethod: methods[1],
        },
      ];
      storedRefunds = [
        {
          returnId: 'ret-a',
          originalPaymentId: cardPayment.id,
          amount: 5,
          status: RefundStatus.COMPLETED,
        },
      ];
      await expect(
        service.create(
          TENANT,
          CLERK,
          returnDto({ refunds: [{ paymentMethodId: 'card', amount: 10 }] }),
        ),
      ).rejects.toThrow(ForbiddenException);
      // Split the way it was paid: no approval needed
      await service.create(
        TENANT,
        CLERK,
        returnDto({
          refunds: [
            { paymentMethodId: 'card', amount: 5 },
            { paymentMethodId: 'cash', amount: 5 },
          ],
        }),
      );
      expect(approvalsService.verify).not.toHaveBeenCalled();
    });

    it('accepts a manager approval for it', async () => {
      approvalsService.verify.mockImplementation((token, permission) =>
        Promise.resolve(
          token === 'approval-1' && permission === 'sales.refund.any_method'
            ? 'manager-1'
            : null,
        ),
      );
      await service.create(
        TENANT,
        CLERK,
        returnDto({ refundMethodId: 'cash' }),
        'approval-1',
      );
      expect(savedRefunds()).toEqual([
        expect.objectContaining({ paymentMethodId: 'cash', amount: 10 }),
      ]);
      expect(manager.create).toHaveBeenCalledWith(
        SaleReturn,
        expect.objectContaining({ approverId: 'manager-1' }),
      );
    });

    it('lets a user with the permission refund to any method', async () => {
      await service.create(
        TENANT,
        OWNER,
        returnDto({ refundMethodId: 'cash' }),
      );
      expect(approvalsService.verify).not.toHaveBeenCalled();
      expect(shiftsService.recordCashMovement).toHaveBeenCalled();
    });

    it('accepts one approval per permission for a user without sales.refund', async () => {
      const cashier = {
        ...CLERK,
        permissions: ['sales.view'],
      } as unknown as AuthUser;
      approvalsService.verify.mockImplementation((token, permission) =>
        Promise.resolve(
          (token === 'refund-ok' && permission === 'sales.refund') ||
            (token === 'method-ok' && permission === 'sales.refund.any_method')
            ? 'manager-1'
            : null,
        ),
      );
      await expect(
        service.create(
          TENANT,
          cashier,
          returnDto({ refundMethodId: 'cash' }),
          'refund-ok',
        ),
      ).rejects.toThrow(ForbiddenException);
      await service.create(
        TENANT,
        cashier,
        returnDto({ refundMethodId: 'cash' }),
        'refund-ok, method-ok',
      );
      expect(savedRefunds()).toHaveLength(1);
    });
  });
  describe('customer credit, stored value, goodwill and exchanges', () => {
    const onAccountMethod = {
      ...method('onacct', PaymentMethodType.ON_ACCOUNT),
      code: 'ON_ACCOUNT',
    };
    const payment = (
      id: string,
      m: typeof onAccountMethod,
      amount: string,
    ) => ({
      id,
      saleId: sale.id,
      paymentMethodId: m.id,
      amount,
      status: PaymentStatus.COMPLETED,
      provider: 'manual',
      providerReference: null,
      metadata: {},
      paymentMethod: m,
    });
    const defaultFindOne = manager.findOne.getMockImplementation()!;
    afterEach(() => manager.findOne.mockImplementation(defaultFindOne));
    const withCustomer = () =>
      manager.findOne.mockImplementation(((entity: unknown) =>
        Promise.resolve(
          entity === Sale
            ? { ...sale, customerId: 'cust-1' }
            : entity === Register
              ? register
              : null,
        )) as never);

    it('takes a return of a sale on account off the account, in proportion', async () => {
      withCustomer();
      payments = [
        payment('pay-acct', onAccountMethod, '15'),
        payment('pay-cash', methods[1], '5'),
      ];
      await service.create(TENANT, OWNER, returnDto());
      // 10.00 returned on a 20.00 sale, 15.00 of it on account → 7.50 credit note
      expect(customerCredit.creditNote).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          customerId: 'cust-1',
          saleId: sale.id,
          amount: 7.5,
        }),
      );
      expect(shiftsService.recordCashMovement).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ amount: 2.5 }),
      );
    });

    it('gives cash paid in HTG back in HTG, at the rate it was paid at', async () => {
      // 20.00 sale paid 2,700 HTG in cash at 135; 10.00 returned → 1,350 HTG back
      payments = [
        {
          ...payment('pay-htg', methods[1], '20'),
          tenderedCurrency: 'HTG',
          tenderedAmount: '2700',
          exchangeRate: '135',
        },
      ];
      await service.create(TENANT, OWNER, returnDto());
      expect(shiftsService.recordCashMovement).toHaveBeenCalledTimes(1);
      expect(shiftsService.recordCashMovement).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          amount: 1350,
          currencyCode: 'HTG',
          sourceType: 'return:HTG',
        }),
      );
    });

    it('credits a sale fully on account without any cash', async () => {
      withCustomer();
      payments = [payment('pay-acct', onAccountMethod, '20')];
      await service.create(TENANT, OWNER, returnDto());
      expect(customerCredit.creditNote).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ amount: 10 }),
      );
      expect(shiftsService.recordCashMovement).not.toHaveBeenCalled();
    });

    it("refunds to store credit (the sale's customer, or the one chosen)", async () => {
      await service.create(
        TENANT,
        CLERK,
        returnDto({ refundToStoreCredit: true, customerId: 'cust-9' }),
      );
      expect(storedValue.storeCreditAccount).toHaveBeenCalledWith(
        manager,
        TENANT,
        'cust-9',
        'USD',
      );
      expect(storedValue.refundTo).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ accountId: 'sc-1', amount: 10 }),
      );
      // No approval needed: the money stays in the store
      expect(savedRefunds()).toEqual([
        expect.objectContaining({
          paymentMethodId: 'store_credit',
          amount: 10,
        }),
      ]);
      expect(shiftsService.recordCashMovement).not.toHaveBeenCalled();
    });

    it('gives a goodwill refund without goods: approval needed, no stock movement', async () => {
      const goodwill = returnDto({
        type: 'goodwill',
        goodwillAmount: 5,
        items: [],
      });
      await expect(
        service.create(TENANT, CLERK, goodwill),
      ).rejects.toMatchObject({
        response: {
          missingPermissions: ['sales.refund.goodwill'],
          approvable: true,
        },
      });

      await service.create(TENANT, OWNER, goodwill);
      expect(inventoryService.applyMovement).not.toHaveBeenCalled();
      const saved = manager.save.mock.calls.find(
        (c) => (c[0] as { returnType?: string }).returnType,
      )?.[0] as { returnType: string; total: number };
      expect(saved).toMatchObject({ returnType: 'goodwill', total: 5 });
      // The goods stay with the customer: the sale keeps its status
      expect(manager.update).not.toHaveBeenCalledWith(
        Sale,
        expect.anything(),
        expect.objectContaining({ status: expect.anything() as unknown }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'sale.goodwill_refund' }),
        manager,
      );
    });

    it('puts damaged goods in the damaged / quarantine location', async () => {
      await service.create(
        TENANT,
        OWNER,
        returnDto({
          items: [
            {
              saleItemId: saleItem.id,
              quantity: 1,
              disposition: ReturnDisposition.DAMAGED,
            },
          ],
        }),
      );
      expect(inventoryService.resolveConditionLocation).toHaveBeenCalledWith(
        manager,
        TENANT,
        'loc-1',
        'damaged',
      );
      expect(inventoryService.applyMovement).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ locationId: 'loc-quarantine', delta: 1 }),
      );
    });

    it("refuses to restock at a location outside the user's branches (404)", async () => {
      const limited = {
        ...OWNER,
        branchIds: ['b1'],
      } as unknown as AuthUser;
      Object.assign(register, { branchId: 'b1' });
      try {
        await expect(
          service.create(
            TENANT,
            limited,
            returnDto({
              items: [
                {
                  saleItemId: saleItem.id,
                  quantity: 1,
                  disposition: ReturnDisposition.RESTOCK,
                  locationId: 'loc-other-branch',
                },
              ],
            }),
          ),
        ).rejects.toThrow('Stock location not found');
        expect(inventoryService.applyMovement).not.toHaveBeenCalled();
        // The location query ran for the user's branches
        expect(manager.query).toHaveBeenCalledWith(
          expect.stringContaining('branch_warehouses'),
          [TENANT, ['b1'], 'loc-other-branch'],
        );
      } finally {
        delete (register as { branchId?: string }).branchId;
      }
    });

    it('records return.completed in the return transaction', async () => {
      await service.create(TENANT, OWNER, returnDto());
      expect(outbox.record).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({
          type: 'return.completed',
          payload: expect.objectContaining({
            originalSaleId: sale.id,
            total: 10,
          }) as unknown,
        }),
      );
    });

    it('applies an exchange return to the replacement sale, refunding only the rest', async () => {
      await service.create(TENANT, OWNER, returnDto(), undefined, {
        exchange: { newSaleTotal: 4 },
      });
      expect(savedRefunds()).toEqual([
        expect.objectContaining({
          paymentMethodId: 'exchange_credit',
          amount: 4,
        }),
        expect.objectContaining({ paymentMethodId: 'card', amount: 6 }),
      ]);
      expect(manager.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          returnTotal: 10,
          creditAmount: 4,
          newSaleTotal: 4,
          difference: -6,
          status: 'pending',
        }),
      );
    });
  });

  describe('exchange credit refunds (cancel / replacement worth less)', () => {
    let link: Partial<ExchangeLink>;
    const creditRow = {
      id: 'refund-credit',
      returnId: 'ret-1',
      paymentMethodId: 'exchange_credit',
      amount: '10',
    };
    beforeEach(() => {
      link = {
        id: 'x-1',
        tenantId: TENANT,
        originalSaleId: sale.id,
        returnId: 'ret-1',
        newSaleId: null,
        status: ExchangeStatus.INCOMPLETE,
        returnTotal: 10,
        creditAmount: 10,
        newSaleTotal: 10,
        difference: 0,
      };
      // The exchange credit already counts against the sale
      storedRefunds = [
        {
          returnId: 'ret-1',
          originalPaymentId: null,
          amount: 10,
          status: RefundStatus.COMPLETED,
        },
      ];
      (manager.findOne as jest.Mock).mockImplementation((entity: unknown) =>
        Promise.resolve(
          entity === ExchangeLink
            ? { ...link }
            : entity === Sale
              ? { ...sale }
              : entity === Register
                ? register
                : entity === SaleReturnRefund
                  ? { ...creditRow }
                  : null,
        ),
      );
      manager.findOneOrFail.mockResolvedValue({
        id: 'ret-1',
        returnNumber: 'MAIN-R-000001',
      });
      (dataSource.getRepository as jest.Mock).mockImplementation(
        (entity: unknown) =>
          entity === ExchangeLink
            ? { findOneOrFail: jest.fn(() => Promise.resolve({ ...link })) }
            : refundRepository,
      );
    });
    afterEach(() => {
      (manager.findOne as jest.Mock).mockImplementation((entity: unknown) =>
        Promise.resolve(
          entity === Sale ? { ...sale } : entity === Register ? register : null,
        ),
      );
      (dataSource.getRepository as jest.Mock).mockImplementation(
        () => refundRepository,
      );
    });

    const release = (
      user: AuthUser,
      extra: Partial<Parameters<ReturnsService['releaseExchangeCredit']>[2]>,
    ) =>
      service.releaseExchangeCredit(TENANT, user, {
        exchangeId: 'x-1',
        amount: 'all',
        registerId: register.id,
        reason: 'Customer changed their mind',
        cancel: true,
        ...extra,
      });

    it('cancels: the whole credit goes back to the original payment', async () => {
      await release(OWNER, {});
      expect(manager.delete).toHaveBeenCalledWith(SaleReturnRefund, {
        id: 'refund-credit',
        tenantId: TENANT,
      });
      expect(savedRefunds()).toEqual([
        expect.objectContaining({
          paymentMethodId: 'card',
          amount: 10,
          originalPaymentId: 'pay-card',
        }),
      ]);
      expect(manager.update).toHaveBeenCalledWith(
        ExchangeLink,
        { id: 'x-1', tenantId: TENANT },
        expect.objectContaining({
          creditAmount: 0,
          status: ExchangeStatus.CANCELLED,
          difference: -10,
        }),
      );
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'exchange.cancelled' }),
        manager,
      );
    });

    it('refunds part of the credit and keeps the rest for the replacement', async () => {
      await release(OWNER, { amount: 4, cancel: false });
      expect(manager.update).toHaveBeenCalledWith(
        SaleReturnRefund,
        { id: 'refund-credit', tenantId: TENANT },
        { amount: 6 },
      );
      expect(savedRefunds()).toEqual([
        expect.objectContaining({ paymentMethodId: 'card', amount: 4 }),
      ]);
      expect(manager.update).toHaveBeenCalledWith(
        ExchangeLink,
        { id: 'x-1', tenantId: TENANT },
        { creditAmount: 6, newSaleTotal: 6, difference: -4 },
      );
    });

    it("needs sales.refund.any_method (or a manager) to refund to a tender the sale didn't use", async () => {
      await expect(
        release(CLERK, { refundMethodId: 'cash' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      approvalsService.verify.mockImplementation((_token, permission) =>
        Promise.resolve(
          permission === 'sales.refund.any_method' ? 'manager-1' : null,
        ),
      );
      await service.releaseExchangeCredit(
        TENANT,
        CLERK,
        {
          exchangeId: 'x-1',
          amount: 'all',
          registerId: register.id,
          reason: 'Cancelled',
          refundMethodId: 'cash',
          cancel: true,
        },
        'approval-token',
      );
      expect(shiftsService.recordCashMovement).toHaveBeenCalledWith(
        manager,
        expect.objectContaining({ amount: 10, approverId: 'manager-1' }),
      );
    });

    it('refuses once the exchange is completed', async () => {
      link.status = ExchangeStatus.COMPLETED;
      link.newSaleId = 'sale-2';
      await expect(release(OWNER, {})).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });
});
