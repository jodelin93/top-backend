import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DeepPartial } from 'typeorm';
import {
  Discount,
  DiscountScope,
  DiscountStatus,
  DiscountType,
} from '../database/entities/discount.entity';
import { DiscountsService } from './discounts.service';

const TENANT = 'tenant-1';
const DAY = 24 * 60 * 60 * 1000;

describe('DiscountsService', () => {
  let service: DiscountsService;
  const repository = {
    findOne: jest.fn(),
    create: jest.fn((data: DeepPartial<Discount>) => data),
    save: jest.fn((entity: Discount) => Promise.resolve(entity)),
  };

  const discount = (extra: Partial<Discount> = {}): Discount =>
    ({
      id: 'd1',
      tenantId: TENANT,
      code: 'SAVE10',
      discountType: DiscountType.PERCENTAGE,
      scope: DiscountScope.CART,
      percentage: 10,
      status: DiscountStatus.ACTIVE,
      usageLimit: null,
      usageCount: 0,
      validFrom: null,
      validTo: null,
      applicableProductIds: [],
      applicableCategoryIds: [],
      excludedProductIds: [],
      ...extra,
    }) as unknown as Discount;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        DiscountsService,
        { provide: getRepositoryToken(Discount), useValue: repository },
      ],
    }).compile();
    service = module.get(DiscountsService);
  });

  describe('create', () => {
    it('uppercases the code and scopes it to the tenant', async () => {
      const created = await service.create(TENANT, {
        code: 'summer',
        discountType: DiscountType.PERCENTAGE,
        scope: DiscountScope.CART,
        percentage: 15,
      });
      expect(created).toMatchObject({ code: 'SUMMER', tenantId: TENANT });
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it.each([
      [
        'percentage without a percentage',
        { discountType: DiscountType.PERCENTAGE, scope: DiscountScope.CART },
        'Percentage discounts need a percentage',
      ],
      [
        'fixed amount without a value',
        { discountType: DiscountType.FIXED_AMOUNT, scope: DiscountScope.CART },
        'Fixed amount discounts need a value',
      ],
      [
        'buy X get Y without quantities',
        {
          discountType: DiscountType.BUY_X_GET_Y,
          scope: DiscountScope.PRODUCT,
          buyQuantity: 2,
          applicableProductIds: ['p1'],
        },
        'Buy X get Y discounts need buy and get quantities',
      ],
      [
        'buy X get Y on the whole cart',
        {
          discountType: DiscountType.BUY_X_GET_Y,
          scope: DiscountScope.CART,
          buyQuantity: 2,
          getQuantity: 1,
        },
        'Buy X get Y discounts apply to products or categories',
      ],
      [
        'product scope without products',
        {
          discountType: DiscountType.PERCENTAGE,
          scope: DiscountScope.PRODUCT,
          percentage: 10,
          applicableProductIds: [],
        },
        'Product discounts need at least one product',
      ],
      [
        'category scope without categories',
        {
          discountType: DiscountType.PERCENTAGE,
          scope: DiscountScope.CATEGORY,
          percentage: 10,
        },
        'Category discounts need at least one category',
      ],
    ])('rejects %s', async (_label, data, message) => {
      await expect(
        service.create(TENANT, { code: 'X', ...data }),
      ).rejects.toThrow(new BadRequestException(message));
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('accepts a valid buy X get Y product discount', async () => {
      await expect(
        service.create(TENANT, {
          code: 'bogo',
          discountType: DiscountType.BUY_X_GET_Y,
          scope: DiscountScope.PRODUCT,
          buyQuantity: 1,
          getQuantity: 1,
          applicableProductIds: ['p1'],
        }),
      ).resolves.toMatchObject({ code: 'BOGO' });
    });
  });

  describe('update', () => {
    it('validates the merged result, not just the patch', async () => {
      repository.findOne.mockResolvedValue(discount());
      // Switching to fixed amount without giving a value is invalid
      await expect(
        service.update(TENANT, 'd1', {
          discountType: DiscountType.FIXED_AMOUNT,
        }),
      ).rejects.toThrow('Fixed amount discounts need a value');
    });

    it('uppercases a new code', async () => {
      repository.findOne.mockResolvedValue(discount());
      const updated = await service.update(TENANT, 'd1', { code: 'new10' });
      expect(updated.code).toBe('NEW10');
    });

    it('404s for another tenant’s discount', async () => {
      repository.findOne.mockResolvedValue(null);
      await expect(service.update(TENANT, 'd1', {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('findUsableByCode', () => {
    it('looks the code up trimmed and uppercased, within the tenant', async () => {
      repository.findOne.mockResolvedValue(discount());
      await expect(
        service.findUsableByCode(TENANT, '  save10 '),
      ).resolves.toMatchObject({ id: 'd1' });
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { tenantId: TENANT, code: 'SAVE10' },
      });
    });

    it('404s for an unknown code', async () => {
      repository.findOne.mockResolvedValue(null);
      await expect(service.findUsableByCode(TENANT, 'nope')).rejects.toThrow(
        NotFoundException,
      );
    });

    it.each([
      [
        'inactive',
        { status: DiscountStatus.INACTIVE },
        'This discount is not active',
      ],
      [
        'not started yet',
        { validFrom: new Date(Date.now() + DAY) },
        'This discount has not started yet',
      ],
      [
        'expired',
        { validTo: new Date(Date.now() - DAY) },
        'This discount has expired',
      ],
      [
        'used up',
        { usageLimit: 5, usageCount: 5 },
        'This discount has reached its usage limit',
      ],
    ])('rejects a discount that is %s', async (_label, extra, message) => {
      repository.findOne.mockResolvedValue(discount(extra));
      await expect(service.findUsableByCode(TENANT, 'SAVE10')).rejects.toThrow(
        new BadRequestException(message),
      );
    });

    it('accepts a discount inside its window with uses left', async () => {
      repository.findOne.mockResolvedValue(
        discount({
          validFrom: new Date(Date.now() - DAY),
          validTo: new Date(Date.now() + DAY),
          usageLimit: 5,
          usageCount: 4,
        }),
      );
      await expect(
        service.findUsableByCode(TENANT, 'SAVE10'),
      ).resolves.toBeDefined();
    });
  });
});
