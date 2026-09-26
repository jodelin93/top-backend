import { DataSource } from 'typeorm';
import { SettingsService } from '../settings/settings.service';
import { PricingService } from '../price-lists/pricing.service';
import { LoyaltyService } from '../loyalty/loyalty.service';
import { Register } from '../database/entities/register.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { PosService } from './pos.service';
import { TaxResolverService } from './tax-resolver.service';

const variant = (id: string, productId = `p-${id}`) =>
  ({
    id,
    productId,
    sku: id.toUpperCase(),
    barcode: null,
    status: 'active',
    name: null,
    imageUrl: null,
    product: {
      id: productId,
      status: 'active',
      name: { en: id },
      categoryId: null,
      isStockTracked: true,
      allowBackorder: false,
      taxCategoryId: null,
    },
  }) as unknown as ProductVariant;

describe('PosService catalog', () => {
  const register = {
    id: 'reg-1',
    branchId: 'br-1',
    defaultLocationId: null,
  } as unknown as Register;
  let wheres: [string, Record<string, unknown> | undefined][];
  let variants: ProductVariant[];
  let assortment: { productId: string; branchId: string }[];
  let service: PosService;

  beforeEach(() => {
    wheres = [];
    variants = [variant('v1')];
    assortment = [];
    const qb: Record<string, unknown> = {};
    Object.assign(qb, {
      innerJoinAndSelect: () => qb,
      leftJoinAndSelect: () => qb,
      where: () => qb,
      orderBy: () => qb,
      addOrderBy: () => qb,
      take: () => qb,
      andWhere: (sql: string, params?: Record<string, unknown>) => {
        wheres.push([sql, params]);
        return qb;
      },
      getMany: () => Promise.resolve(variants),
    });
    const dataSource = {
      getRepository: (entity: unknown) =>
        entity === Register
          ? { findOne: () => Promise.resolve(register) }
          : entity === ProductVariant
            ? {
                createQueryBuilder: () => qb,
                find: () => Promise.resolve(variants),
              }
            : { find: () => Promise.resolve([]) },
      query: jest.fn(() => Promise.resolve(assortment)),
    };
    service = new PosService(
      dataSource as unknown as DataSource,
      {} as SettingsService,
      {
        resolvePrices: jest.fn(() => Promise.resolve(new Map([['v1', 9]]))),
      } as unknown as PricingService,
      {
        load: jest.fn(() => Promise.resolve({ rateFor: () => 0.1 })),
      } as unknown as TaxResolverService,
      {} as LoyaltyService,
    );
  });

  it("filters the catalog by the register's branch assortment", async () => {
    const items = await service.getCatalog('t1', { registerId: 'reg-1' });
    const branch = wheres.find(([sql]) => sql.includes('product_branches'));
    expect(branch?.[1]).toEqual({ branchId: 'br-1' });
    expect(items[0]).toMatchObject({
      variantId: 'v1',
      price: 9,
      taxRate: 0.1,
      stockTracked: true,
    });
  });

  it('does not filter by branch without a register', async () => {
    await service.getCatalog('t1', {});
    expect(wheres.some(([sql]) => sql.includes('product_branches'))).toBe(
      false,
    );
  });

  it('normalizes a scanned barcode like stored ones, SKU as typed', async () => {
    await service.getCatalog('t1', {
      registerId: 'reg-1',
      barcode: ' abc 12-x ',
    });
    const scan = wheres.find(([sql]) =>
      sql.includes('variant.barcode = :barcode'),
    );
    expect(scan?.[1]).toEqual({ barcode: 'ABC12-X', rawCode: 'abc 12-x' });
    await service.getCatalog('t1', { barcode: '0360 0029 1452' });
    expect(wheres.at(-1)?.[1]).toMatchObject({ barcode: '036000291452' });
  });

  it('sync items: drops variants not sold at the branch (tombstones)', async () => {
    variants = [variant('v1', 'p1'), variant('v2', 'p2'), variant('v3', 'p3')];
    assortment = [
      { productId: 'p1', branchId: 'br-1' },
      { productId: 'p2', branchId: 'br-other' },
    ];
    const items = await service.catalogItemsFor(
      't1',
      ['v1', 'v2', 'v3'],
      register,
    );
    // p1 sold here, p2 only elsewhere, p3 has no assortment (sold everywhere)
    expect(items.map((i) => i.variantId)).toEqual(['v1', 'v3']);
  });
});

describe('PosService catalog: weighted / price-embedded barcodes', () => {
  const ean = (body12: string) => {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += Number(body12[11 - i]) * (i % 2 === 0 ? 3 : 1);
    }
    return `${body12}${(10 - (sum % 10)) % 10}`;
  };
  const apples = {
    ...variant('apples'),
    pluCode: '1234',
    product: {
      ...variant('apples').product,
      unit: { code: 'kg', allowsDecimals: true, precision: 3 },
    },
  } as unknown as ProductVariant;

  function build(options: {
    layout: 'weight' | 'price';
    byPlu: ProductVariant[];
    byBarcode?: ProductVariant[];
  }) {
    const wheres: [string, Record<string, unknown> | undefined][] = [];
    const makeQb = (source: () => ProductVariant[]) => {
      const qb: Record<string, unknown> = {};
      let plu = false;
      Object.assign(qb, {
        innerJoinAndSelect: () => qb,
        leftJoinAndSelect: () => qb,
        where: () => qb,
        orderBy: () => qb,
        addOrderBy: () => qb,
        take: () => qb,
        andWhere: (sql: string, params?: Record<string, unknown>) => {
          wheres.push([sql, params]);
          if (sql.includes('pluCode')) plu = true;
          return qb;
        },
        clone: () => makeQb(() => options.byPlu),
        getMany: () => Promise.resolve(plu ? options.byPlu : source()),
      });
      return qb;
    };
    const dataSource = {
      getRepository: (entity: unknown) =>
        entity === ProductVariant
          ? { createQueryBuilder: () => makeQb(() => options.byBarcode ?? []) }
          : { find: () => Promise.resolve([]), findOne: () => null },
      query: jest.fn(() => Promise.resolve([])),
    };
    const settings = {
      getSettings: jest.fn(() =>
        Promise.resolve({
          weightedBarcodePrefixes: ['20', '21'],
          weightedBarcodeLayout: options.layout,
          weightedBarcodeItemCodeLength: 5,
          weightedBarcodeValueDecimals: options.layout === 'weight' ? 3 : 2,
        }),
      ),
    };
    const service = new PosService(
      dataSource as unknown as DataSource,
      settings as unknown as SettingsService,
      {
        resolvePrices: jest.fn((_t: string, list: ProductVariant[]) =>
          Promise.resolve(new Map(list.map((v) => [v.id, 3.99]))),
        ),
      } as unknown as PricingService,
      {
        load: jest.fn(() => Promise.resolve({ rateFor: () => 0 })),
      } as unknown as TaxResolverService,
      {} as LoyaltyService,
    );
    return { service, wheres };
  }

  it('finds the item by its PLU and returns the weight as quantity', async () => {
    const { service, wheres } = build({ layout: 'weight', byPlu: [apples] });
    const code = ean('210123401250');
    const [item] = await service.getCatalog('t1', { barcode: code });
    expect(wheres).toContainEqual(['variant.pluCode = :plu', { plu: '1234' }]);
    expect(item).toMatchObject({
      variantId: 'apples',
      price: 3.99,
      unit: { code: 'kg', allowsDecimals: true, precision: 3 },
      pluCode: '1234',
      scan: { barcode: code, quantity: 1.25, amount: null },
    });
  });

  it('computes the quantity from an embedded price', async () => {
    const { service } = build({ layout: 'price', byPlu: [apples] });
    const [item] = await service.getCatalog('t1', {
      barcode: ean('210123400499'),
    });
    expect(item.scan).toMatchObject({ quantity: 1.251, amount: 4.99 });
  });

  it('unknown PLU: falls back to an ordinary barcode lookup', async () => {
    const { service, wheres } = build({ layout: 'weight', byPlu: [] });
    const items = await service.getCatalog('t1', {
      barcode: ean('210999901250'),
    });
    expect(items).toEqual([]);
    expect(
      wheres.some(([sql]) => sql.includes('variant.barcode = :barcode')),
    ).toBe(true);
  });

  it('bad check digit and no such barcode: refused', async () => {
    const { service } = build({ layout: 'weight', byPlu: [apples] });
    const good = ean('210123401250');
    const bad = `${good.slice(0, 12)}${(Number(good[12]) + 1) % 10}`;
    await expect(service.getCatalog('t1', { barcode: bad })).rejects.toThrow(
      'The check digit of this weighted barcode is wrong',
    );
  });
});
