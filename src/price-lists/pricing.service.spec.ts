import { Repository } from 'typeorm';
import { PriceEntry } from '../database/entities/price-entry.entity';
import {
  PriceList,
  PriceListType,
} from '../database/entities/price-list.entity';
import { CustomerGroup } from '../database/entities/customer-group.entity';
import { PricingService } from './pricing.service';

describe('PricingService.needsPriceOverride', () => {
  const lists = new Map<string, Partial<PriceList>>([
    ['std', { id: 'std', priceListType: PriceListType.STANDARD }],
    ['promo', { id: 'promo', priceListType: PriceListType.PROMOTIONAL }],
    ['wholesale', { id: 'wholesale', priceListType: PriceListType.WHOLESALE }],
    ['staff', { id: 'staff', priceListType: PriceListType.MEMBER }],
  ]);
  const groups = new Map<string, Partial<CustomerGroup>>([
    ['trade', { id: 'trade', priceListId: 'wholesale' }],
  ]);
  const manager = {
    findOne: jest.fn(
      (entity: unknown, options: { where: { id: string; tenantId: string } }) =>
        Promise.resolve(
          options.where.tenantId !== 't1'
            ? null
            : entity === PriceList
              ? (lists.get(options.where.id) ?? null)
              : (groups.get(options.where.id) ?? null),
        ),
    ),
  };
  const service = new PricingService({
    manager,
  } as unknown as Repository<PriceEntry>);

  it('lets lists that apply to everyone through', async () => {
    await expect(service.needsPriceOverride('t1', 'std', null)).resolves.toBe(
      false,
    );
    await expect(service.needsPriceOverride('t1', 'promo', null)).resolves.toBe(
      false,
    );
  });

  it("treats another list as a price change unless it is the customer's group list", async () => {
    await expect(
      service.needsPriceOverride('t1', 'wholesale', null),
    ).resolves.toBe(true);
    await expect(
      service.needsPriceOverride('t1', 'wholesale', 'trade'),
    ).resolves.toBe(false);
    await expect(
      service.needsPriceOverride('t1', 'staff', 'trade'),
    ).resolves.toBe(true);
  });

  it("needs nothing for a list that doesn't exist in the store (it prices nothing)", async () => {
    await expect(
      service.needsPriceOverride('t2', 'wholesale', null),
    ).resolves.toBe(false);
  });
});

describe('PricingService.customerGroupPricing', () => {
  const groups = new Map<string, Partial<CustomerGroup>>([
    [
      'trade',
      {
        id: 'trade',
        name: 'Trade',
        priceListId: 'wholesale',
        discountPercent: '5.50' as unknown as number,
        isActive: true,
      },
    ],
    [
      'staff',
      { id: 'staff', name: 'Staff', priceListId: null, discountPercent: 20 },
    ],
    [
      'old',
      {
        id: 'old',
        name: 'Old',
        priceListId: 'x',
        discountPercent: 10,
        isActive: false,
      },
    ],
    [
      'plain',
      { id: 'plain', name: 'Plain', priceListId: null, discountPercent: 0 },
    ],
  ]);
  const manager = {
    findOne: jest.fn(
      (
        _entity: unknown,
        options: { where: { id: string; tenantId: string } },
      ) =>
        Promise.resolve(
          options.where.tenantId === 't1'
            ? (groups.get(options.where.id) ?? null)
            : null,
        ),
    ),
  };
  const service = new PricingService({
    manager,
  } as unknown as Repository<PriceEntry>);

  it("gives the group's list and discount (numeric column as a number)", async () => {
    await expect(service.customerGroupPricing('t1', 'trade')).resolves.toEqual({
      id: 'trade',
      name: 'Trade',
      priceListId: 'wholesale',
      discountPercent: 5.5,
    });
    await expect(
      service.customerGroupPricing('t1', 'staff'),
    ).resolves.toMatchObject({ priceListId: null, discountPercent: 20 });
  });

  it('ignores no group, inactive groups, groups without pricing and other stores', async () => {
    await expect(service.customerGroupPricing('t1', null)).resolves.toBeNull();
    await expect(service.customerGroupPricing('t1', 'old')).resolves.toBeNull();
    await expect(
      service.customerGroupPricing('t1', 'plain'),
    ).resolves.toBeNull();
    await expect(
      service.customerGroupPricing('t2', 'trade'),
    ).resolves.toBeNull();
  });
});
