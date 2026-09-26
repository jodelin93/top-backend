import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { SalesService } from '../sales/sales.service';
import { ALL_PERMISSIONS } from '../auth/permissions';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { Sale } from '../database/entities/sale.entity';
import {
  ExchangeLink,
  ExchangeStatus,
} from '../database/entities/exchange-link.entity';
import { PaymentMethod } from '../database/entities/payment-method.entity';
import { ReturnDisposition } from '../database/entities/sale-return-item.entity';
import { ReturnsService } from './returns.service';
import { ExchangesService } from './exchanges.service';
import { CreateExchangeDto } from './returns.dto';

const TENANT = 'tenant-1';
const USER = {
  id: 'user-1',
  tenantId: TENANT,
  permissions: ALL_PERMISSIONS,
} as unknown as AuthUser;

describe('ExchangesService', () => {
  let link: Partial<ExchangeLink>;
  const linkRepo = {
    findOne: jest.fn(() => Promise.resolve({ ...link })),
    findOneOrFail: jest.fn(() => Promise.resolve({ ...link })),
    update: jest.fn((_where: unknown, patch: Partial<ExchangeLink>) => {
      Object.assign(link, patch);
      return Promise.resolve();
    }),
  };
  const saleRepo = {
    findOne: jest.fn(() =>
      Promise.resolve({ id: 'sale-1', customerId: 'cust-1' }),
    ),
  };
  const methodRepo = {
    findOne: jest.fn(() =>
      Promise.resolve({ id: 'pm-exchange', code: 'EXCHANGE_CREDIT' }),
    ),
  };
  const dataSource = {
    manager: { getRepository: () => methodRepo },
    getRepository: jest.fn((entity: unknown) =>
      entity === ExchangeLink
        ? linkRepo
        : entity === Sale
          ? saleRepo
          : entity === PaymentMethod
            ? methodRepo
            : null,
    ),
  };
  const returnsService = {
    create: jest.fn(() => Promise.resolve({ id: 'ret-1', total: 10 })),
    findOne: jest.fn(() => Promise.resolve({ id: 'ret-1' })),
    // Gives back part of the credit: the exchange keeps the rest
    releaseExchangeCredit: jest.fn(
      (
        _t: string,
        _u: AuthUser,
        input: { amount: number | 'all'; cancel: boolean },
      ) => {
        const credit = Number(link.creditAmount);
        const amount = input.amount === 'all' ? credit : input.amount;
        Object.assign(link, {
          creditAmount: Math.round((credit - amount) * 100) / 100,
          ...(input.cancel && { status: ExchangeStatus.CANCELLED }),
        });
        return Promise.resolve({ ...link });
      },
    ),
  };
  const salesService = {
    quote: jest.fn(),
    create: jest.fn(() => {
      Object.assign(link, {
        status: ExchangeStatus.COMPLETED,
        newSaleId: 'sale-2',
      });
      return Promise.resolve({ id: 'sale-2' });
    }),
    findOne: jest.fn(() => Promise.resolve({ id: 'sale-2' })),
  };
  const audit = { record: jest.fn() };
  const service = new ExchangesService(
    dataSource as unknown as DataSource,
    returnsService as unknown as ReturnsService,
    salesService as unknown as SalesService,
    audit as unknown as AuditService,
  );

  const dto = (payments: CreateExchangeDto['newSale']['payments']) =>
    ({
      saleId: 'sale-1',
      registerId: 'reg-1',
      reason: 'Wrong size',
      idempotencyKey: 'exchange-key-1',
      items: [
        {
          saleItemId: 'si-1',
          quantity: 1,
          disposition: ReturnDisposition.RESTOCK,
        },
      ],
      newSale: { items: [{ variantId: 'var-2', quantity: 1 }], payments },
    }) as CreateExchangeDto;

  const setup = (newTotal: number, returnTotal = 10) => {
    salesService.quote.mockResolvedValue({ total: newTotal });
    link = {
      id: 'x-1',
      tenantId: TENANT,
      originalSaleId: 'sale-1',
      returnId: 'ret-1',
      newSaleId: null,
      status: ExchangeStatus.PENDING,
      returnTotal,
      creditAmount: Math.min(returnTotal, newTotal),
      newSaleTotal: newTotal,
      difference: newTotal - returnTotal,
    };
  };

  beforeEach(() => jest.clearAllMocks());

  it('charges the difference when the new item costs more', async () => {
    setup(15);
    const result = await service.create(
      TENANT,
      USER,
      dto([{ paymentMethodId: 'cash', amount: 5 }]),
    );
    expect(returnsService.create).toHaveBeenCalledWith(
      TENANT,
      USER,
      expect.objectContaining({ idempotencyKey: 'exchange-key-1' }),
      undefined,
      { exchange: { newSaleTotal: 15 } },
    );
    expect(salesService.create).toHaveBeenCalledWith(
      TENANT,
      USER,
      expect.objectContaining({
        customerId: 'cust-1',
        payments: [
          { paymentMethodId: 'pm-exchange', amount: 10 },
          { paymentMethodId: 'cash', amount: 5 },
        ],
        idempotencyKey: 'exchange:x-1',
      }),
      undefined,
      {
        exchange: {
          linkId: 'x-1',
          creditAmount: 10,
          originalSaleId: 'sale-1',
        },
      },
    );
    expect(result.exchange.status).toBe(ExchangeStatus.COMPLETED);
    expect(result.sale).toEqual({ id: 'sale-2' });
    expect(result.error).toBeNull();
  });

  it('refunds the difference on the return when the new item costs less', async () => {
    setup(4);
    await service.create(TENANT, USER, dto([]));
    // The return plans the 6.00 refund; the new sale is paid by 4.00 of credit only
    expect(returnsService.create).toHaveBeenCalledWith(
      TENANT,
      USER,
      expect.anything(),
      undefined,
      { exchange: { newSaleTotal: 4 } },
    );
    expect(salesService.create).toHaveBeenCalledWith(
      TENANT,
      USER,
      expect.objectContaining({
        payments: [{ paymentMethodId: 'pm-exchange', amount: 4 }],
      }),
      undefined,
      expect.anything(),
    );
  });

  it('keeps the return and marks the exchange incomplete when the new sale fails', async () => {
    setup(15);
    salesService.create.mockRejectedValueOnce(
      new BadRequestException('Out of stock'),
    );
    const result = await service.create(
      TENANT,
      USER,
      dto([{ paymentMethodId: 'cash', amount: 5 }]),
    );
    expect(result.exchange.status).toBe(ExchangeStatus.INCOMPLETE);
    expect(result.error).toBe('Out of stock');
    expect(result.sale).toBeNull();
    expect(result.saleReturn).toEqual({ id: 'ret-1' });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'exchange.incomplete' }),
    );
  });

  it('lets a manager approve the new sale: an approvable 403 goes back to the till', async () => {
    setup(15);
    salesService.create.mockRejectedValueOnce(
      new ForbiddenException({
        approvable: true,
        missingPermissions: ['customers.credit.sell'],
      }),
    );
    await expect(
      service.create(TENANT, USER, dto([{ paymentMethodId: 'x', amount: 5 }])),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(link.status).toBe(ExchangeStatus.INCOMPLETE);
  });

  it('pays the exact difference with the chosen method', async () => {
    setup(15.37);
    await service.create(TENANT, USER, {
      ...dto([]),
      newSale: {
        items: [{ variantId: 'var-2', quantity: 1 }],
        payments: [],
        differenceMethodId: 'card',
      },
    });
    expect(salesService.create).toHaveBeenCalledWith(
      TENANT,
      USER,
      expect.objectContaining({
        payments: [
          { paymentMethodId: 'pm-exchange', amount: 10 },
          { paymentMethodId: 'card', amount: 5.37 },
        ],
      }),
      undefined,
      expect.anything(),
    );
  });

  it('completes an incomplete exchange later', async () => {
    setup(15);
    link.status = ExchangeStatus.INCOMPLETE;
    const result = await service.complete(TENANT, USER, 'x-1', {
      registerId: 'reg-1',
      newSale: {
        items: [{ variantId: 'var-3', quantity: 1 }],
        payments: [{ paymentMethodId: 'cash', amount: 5 }],
      },
    });
    expect(result.exchange.status).toBe(ExchangeStatus.COMPLETED);
  });

  it('refunds the rest of the credit when the replacement costs less, in the same completion', async () => {
    setup(15);
    link.status = ExchangeStatus.INCOMPLETE;
    // Cheaper item chosen at completion: 6.00 against 10.00 of credit
    salesService.quote.mockResolvedValue({ total: 6 });
    const result = await service.complete(TENANT, USER, 'x-1', {
      registerId: 'reg-1',
      newSale: {
        items: [{ variantId: 'var-3', quantity: 1 }],
        payments: [],
        creditToStoreCredit: true,
      },
    });
    expect(returnsService.releaseExchangeCredit).toHaveBeenCalledWith(
      TENANT,
      USER,
      expect.objectContaining({
        exchangeId: 'x-1',
        amount: 4,
        refundToStoreCredit: true,
        cancel: false,
      }),
      undefined,
    );
    expect(salesService.create).toHaveBeenCalledWith(
      TENANT,
      USER,
      expect.objectContaining({
        payments: [{ paymentMethodId: 'pm-exchange', amount: 6 }],
      }),
      undefined,
      expect.objectContaining({
        exchange: expect.objectContaining({ creditAmount: 6 }) as unknown,
      }),
    );
    expect(result.exchange.status).toBe(ExchangeStatus.COMPLETED);
  });

  it('refunds nothing when the replacement uses the whole credit', async () => {
    setup(15);
    link.status = ExchangeStatus.INCOMPLETE;
    await service.complete(TENANT, USER, 'x-1', {
      registerId: 'reg-1',
      newSale: {
        items: [{ variantId: 'var-3', quantity: 1 }],
        payments: [{ paymentMethodId: 'cash', amount: 5 }],
      },
    });
    expect(returnsService.releaseExchangeCredit).not.toHaveBeenCalled();
  });

  it('cancels an incomplete exchange by refunding its whole credit', async () => {
    setup(15);
    link.status = ExchangeStatus.INCOMPLETE;
    const result = await service.cancel(
      TENANT,
      USER,
      'x-1',
      {
        registerId: 'reg-1',
        reason: 'No longer wanted',
        refundMethodId: 'cash',
      },
      'token',
    );
    expect(returnsService.releaseExchangeCredit).toHaveBeenCalledWith(
      TENANT,
      USER,
      expect.objectContaining({
        amount: 'all',
        cancel: true,
        refundMethodId: 'cash',
      }),
      'token',
    );
    expect(result.exchange.status).toBe(ExchangeStatus.CANCELLED);
    expect(salesService.create).not.toHaveBeenCalled();
  });

  it('only cancels an incomplete exchange', async () => {
    setup(15);
    link.status = ExchangeStatus.COMPLETED;
    await expect(
      service.cancel(TENANT, USER, 'x-1', {
        registerId: 'reg-1',
        reason: 'x',
      }),
    ).rejects.toThrow('Only an incomplete exchange can be cancelled');
  });
});
