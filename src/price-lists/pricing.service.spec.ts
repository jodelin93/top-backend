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
