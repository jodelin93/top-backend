import { Test } from '@nestjs/testing';
import { DataSource, EntityManager } from 'typeorm';
import { AuditService } from '../audit/audit.service';
import { ProductBarcodesService } from '../products/product-barcodes.service';
import { Category } from '../database/entities/category.entity';
import { TaxCategory } from '../database/entities/tax-category.entity';
import {
  Product,
  ProductStatus,
  ProductType,
} from '../database/entities/product.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { ImportsService } from './imports.service';

const TENANT = 'tenant-1';

const csv = (...lines: string[]) => Buffer.from(lines.join('\n'));

describe('ImportsService', () => {
  let service: ImportsService;
  const audit = { record: jest.fn() };

  // An existing simple product: MUG at 9.99 (cost 3)
  const existing = {
    id: 'prod-1',
    tenantId: TENANT,
    sku: 'MUG',
    name: { en: 'Mug' },
    productType: ProductType.SIMPLE,
    status: ProductStatus.ACTIVE,
    allowBackorder: false,
    variants: [
      {
        id: 'var-1',
        sku: 'MUG',
        productId: 'prod-1',
        sortOrder: 0,
        price: '9.99',
        cost: '3.0000',
      },
    ],
  };

  const manager = {
    find: jest.fn((entity: unknown) => {
      if (entity === Product) return Promise.resolve([existing]);
      if (entity === ProductVariant) {
        return Promise.resolve(existing.variants);
      }
      if (entity === Category || entity === TaxCategory) {
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }),
    create: jest.fn((_entity: unknown, data: object) => data),
    save: jest.fn((data: object) => Promise.resolve({ id: 'new-id', ...data })),
    update: jest.fn(),
  };
  const dataSource = {
    manager,
    transaction: jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager),
    ),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        ImportsService,
        { provide: DataSource, useValue: dataSource },
        { provide: AuditService, useValue: audit },
        {
          provide: ProductBarcodesService,
          useValue: { syncPrimary: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(ImportsService);
  });

  const variantUpdates = () =>
    (manager.update.mock.calls as unknown[][]).filter(
      ([entity]) => entity === ProductVariant,
    );

  it('flags a price change in the preview without applying it by default', async () => {
    const preview = await service.preview(
      TENANT,
      csv('sku,name,price,cost', 'MUG,Big mug,12.50,3'),
    );
    expect(preview.policy).toEqual({
      onExisting: 'update',
      updatePrices: false,
    });
    expect(preview.rows[0]).toMatchObject({
      action: 'update',
      changes: ['name'],
      priceChanges: [{ field: 'price', from: 9.99, to: 12.5, applied: false }],
    });
  });

  it('keeps existing prices when updatePrices is off', async () => {
    const result = await service.apply(
      TENANT,
      csv('sku,name,price,cost', 'MUG,Big mug,12.50,4'),
    );
    expect(result.updated).toBe(1);
    expect(manager.update).toHaveBeenCalledWith(
      Product,
      { id: 'prod-1', tenantId: TENANT },
      expect.objectContaining({ name: { en: 'Big mug' } }),
    );
    expect(variantUpdates()).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'products.imported',
        metadata: expect.objectContaining({
          policy: { onExisting: 'update', updatePrices: false },
          priceChanges: [],
        }) as unknown,
      }),
      manager,
    );
  });

  it('skips a row whose only difference is its price unless prices are updated', async () => {
    const preview = await service.preview(
      TENANT,
      csv('sku,price', 'MUG,12.50'),
    );
    expect(preview.rows[0].action).toBe('skip');
    expect(preview.rows[0].priceChanges).toHaveLength(1);
  });

  it('overwrites prices only when the import opts in, and audits them', async () => {
    const policy = { onExisting: 'update' as const, updatePrices: true };
    const preview = await service.preview(
      TENANT,
      csv('sku,price', 'MUG,12.50'),
      policy,
    );
    expect(preview.rows[0]).toMatchObject({
      action: 'update',
      changes: ['price'],
      priceChanges: [{ field: 'price', from: 9.99, to: 12.5, applied: true }],
    });

    await service.apply(TENANT, csv('sku,price', 'MUG,12.50'), { policy });
    expect(variantUpdates()).toEqual([
      [ProductVariant, { id: 'var-1', tenantId: TENANT }, { price: 12.5 }],
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          policy,
          priceChanges: [
            {
              sku: 'MUG',
              field: 'price',
              from: 9.99,
              to: 12.5,
              applied: true,
            },
          ],
        }) as unknown,
      }),
      manager,
    );
  });

  it('leaves existing products untouched with onExisting=skip', async () => {
    const policy = { onExisting: 'skip' as const, updatePrices: true };
    const result = await service.apply(
      TENANT,
      csv('sku,name,price', 'MUG,Big mug,12.50'),
      { policy },
    );
    expect(result.skipped).toBe(1);
    expect(result.rows[0].priceChanges[0].applied).toBe(false);
    expect(manager.update).not.toHaveBeenCalled();
  });

  it('creates new products without backorders, whatever allow_backorder says (D018)', async () => {
    await service.apply(
      TENANT,
      csv('sku,name,price,allow_backorder', 'NEW,New thing,5,true'),
    );
    expect(manager.create).toHaveBeenCalledWith(
      Product,
      expect.objectContaining({ sku: 'NEW', allowBackorder: false }),
    );
  });
});
