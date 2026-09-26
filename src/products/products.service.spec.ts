import { AuditService } from '../audit/audit.service';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  Product,
  ProductStatus,
  ProductType,
} from '../database/entities/product.entity';
import {
  ProductVariant,
  VariantStatus,
} from '../database/entities/product-variant.entity';
import { Category } from '../database/entities/category.entity';
import { AttributeDefinition } from '../database/entities/attribute-definition.entity';
import { AttributeValue } from '../database/entities/attribute-value.entity';
import { ProductsService } from './products.service';
import { ProductBarcodesService } from './product-barcodes.service';

const TENANT = 'tenant-1';

describe('ProductsService', () => {
  let service: ProductsService;
  const productRepository = { findOne: jest.fn() };
  const variantRepository = { findOne: jest.fn() };
  const categoryRepository = { findOne: jest.fn() };
  const manager = {
    create: jest.fn((_entity: unknown, data: object) => data),
    // Like Postgres, fill in the id and column defaults on insert
    save: jest.fn((data: object) =>
      Promise.resolve({
        id: 'new-id',
        productType: ProductType.SIMPLE,
        ...data,
      }),
    ),
    update: jest.fn(),
    delete: jest.fn(),
    insert: jest.fn(),
  };
  // product_branches / units / branches lookups
  const genericRepository = {
    find: jest.fn(() => Promise.resolve([] as unknown[])),
    exists: jest.fn(() => Promise.resolve(true)),
    count: jest.fn(() => Promise.resolve(0)),
  };
  const dataSource = {
    transaction: jest.fn((work: (m: EntityManager) => Promise<unknown>) =>
      work(manager as unknown as EntityManager),
    ),
    getRepository: jest.fn(() => genericRepository),
  };

  const existingProduct = {
    id: 'prod-1',
    tenantId: TENANT,
    sku: 'MUG',
    barcode: null,
    productType: ProductType.SIMPLE,
    variants: [{ id: 'var-1', sortOrder: 0 }],
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    productRepository.findOne.mockResolvedValue(null);
    variantRepository.findOne.mockResolvedValue(null);
    const module = await Test.createTestingModule({
      providers: [
        { provide: AuditService, useValue: { record: jest.fn() } },
        ProductsService,
        { provide: getRepositoryToken(Product), useValue: productRepository },
        {
          provide: getRepositoryToken(ProductVariant),
          useValue: variantRepository,
        },
        { provide: getRepositoryToken(Category), useValue: categoryRepository },
        { provide: getRepositoryToken(AttributeDefinition), useValue: {} },
        { provide: getRepositoryToken(AttributeValue), useValue: {} },
        { provide: DataSource, useValue: dataSource },
        {
          provide: ProductBarcodesService,
          useValue: { syncPrimary: jest.fn() },
        },
      ],
    }).compile();
    service = module.get(ProductsService);
  });

  describe('create', () => {
    it('gives a simple product a default variant carrying price and cost', async () => {
      productRepository.findOne
        .mockResolvedValueOnce(null) // SKU check
        .mockResolvedValueOnce({ id: 'new-id' }); // reload
      await service.create(TENANT, {
        sku: 'TEE',
        name: { en: 'T-shirt' },
        price: 19.99,
        cost: 7,
      });

      expect(manager.create).toHaveBeenCalledWith(
        Product,
        expect.objectContaining({
          sku: 'TEE',
          tenantId: TENANT,
          status: ProductStatus.ACTIVE,
        }),
      );
      expect(manager.create).toHaveBeenCalledWith(
        ProductVariant,
        expect.objectContaining({
          productId: 'new-id',
          sku: 'TEE',
          price: 19.99,
          cost: 7,
          status: VariantStatus.ACTIVE,
        }),
      );
    });

    it('does not create a default variant for a variable product', async () => {
      productRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'new-id' });
      await service.create(TENANT, {
        sku: 'SHOE',
        name: { en: 'Shoe' },
        productType: ProductType.VARIABLE,
      });
      expect(manager.create).toHaveBeenCalledTimes(1);
    });

    it('never allows negative stock (D018), even when asked for', async () => {
      productRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'new-id' });
      await service.create(TENANT, { sku: 'TEE', name: { en: 'T-shirt' } });
      expect(manager.create).toHaveBeenCalledWith(
        Product,
        expect.objectContaining({ allowBackorder: false }),
      );

      productRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'new-id' });
      await service.create(TENANT, {
        sku: 'CAP',
        name: { en: 'Cap' },
        allowBackorder: true,
      });
      expect(manager.create).toHaveBeenCalledWith(
        Product,
        expect.objectContaining({ sku: 'CAP', allowBackorder: false }),
      );
    });

    it('normalizes tags and saves the branch assortment', async () => {
      productRepository.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'new-id' });
      genericRepository.count.mockResolvedValueOnce(2); // both branches exist
      await service.create(TENANT, {
        sku: 'TEE',
        name: { en: 'T-shirt' },
        tags: [' Summer ', 'summer', 'Cotton  Blend'],
        branchIds: ['b-1', 'b-2'],
      });
      expect(manager.create).toHaveBeenCalledWith(
        Product,
        expect.objectContaining({ tags: ['summer', 'cotton blend'] }),
      );
      expect(manager.insert).toHaveBeenCalledWith(expect.anything(), [
        { tenantId: TENANT, productId: 'new-id', branchId: 'b-1' },
        { tenantId: TENANT, productId: 'new-id', branchId: 'b-2' },
      ]);
    });

    it('rejects a branch or unit from another store', async () => {
      genericRepository.count.mockResolvedValueOnce(0);
      await expect(
        service.create(TENANT, {
          sku: 'TEE',
          name: { en: 'T-shirt' },
          branchIds: ['elsewhere'],
        }),
      ).rejects.toThrow('Branch not found');
      genericRepository.exists.mockResolvedValueOnce(false);
      await expect(
        service.create(TENANT, {
          sku: 'TEE',
          name: { en: 'T-shirt' },
          unitId: 'unit-x',
        }),
      ).rejects.toThrow('Unit not found');
    });

    it('rejects a duplicate product SKU', async () => {
      productRepository.findOne.mockResolvedValueOnce({ id: 'other' });
      await expect(
        service.create(TENANT, { sku: 'MUG', name: { en: 'Mug' } }),
      ).rejects.toThrow(ConflictException);
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('rejects a SKU already used by a variant', async () => {
      variantRepository.findOne.mockResolvedValue({ id: 'some-variant' });
      await expect(
        service.create(TENANT, { sku: 'MUG-RED', name: { en: 'Mug' } }),
      ).rejects.toThrow('A variant with SKU MUG-RED already exists');
    });

    it('rejects a category from another tenant', async () => {
      categoryRepository.findOne.mockResolvedValue(null);
      await expect(
        service.create(TENANT, {
          sku: 'TEE',
          name: { en: 'T-shirt' },
          categoryId: 'cat-x',
        }),
      ).rejects.toThrow('Category not found');
      expect(categoryRepository.findOne).toHaveBeenCalledWith({
        where: { id: 'cat-x', tenantId: TENANT },
      });
    });
  });

  describe('update', () => {
    it('keeps the default variant of a simple product in sync', async () => {
      productRepository.findOne.mockResolvedValue(existingProduct);
      await service.update(TENANT, 'prod-1', { price: 12.5 });
      expect(manager.update).toHaveBeenCalledWith(
        ProductVariant,
        { id: 'var-1', tenantId: TENANT },
        { sku: 'MUG', barcode: null, price: 12.5 },
      );
    });

    it('allows renaming the SKU when only its own variant uses it', async () => {
      productRepository.findOne
        .mockResolvedValueOnce(existingProduct) // load
        .mockResolvedValueOnce(null) // no other product with that SKU
        .mockResolvedValue(existingProduct); // reload
      variantRepository.findOne.mockResolvedValue({ id: 'var-1' });
      await expect(
        service.update(TENANT, 'prod-1', { sku: 'MUG-2' }),
      ).resolves.toBeDefined();
    });

    it('404s for a product outside the tenant', async () => {
      await expect(service.update(TENANT, 'nope', {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('variants', () => {
    it('refuses a second variant with the same option combination', async () => {
      productRepository.findOne.mockResolvedValue(existingProduct);
      variantRepository.findOne
        .mockResolvedValueOnce(null) // SKU free
        .mockResolvedValueOnce({ id: 'var-1', sku: 'MUG-RED' }); // same options
      await expect(
        service.createVariant(TENANT, {
          productId: 'prod-1',
          sku: 'MUG-RED-2',
          attributes: [{ attributeId: 'colour', value: ' Red ' }],
        }),
      ).rejects.toThrow('Variant MUG-RED already has these options');
      expect(variantRepository.findOne).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {
            tenantId: TENANT,
            productId: 'prod-1',
            combinationKey: 'colour=red',
          },
        }),
      );
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });
  });

  it('remove discontinues the product and its variants instead of deleting', async () => {
    productRepository.findOne.mockResolvedValue(existingProduct);
    await service.remove(TENANT, 'prod-1');
    expect(manager.update).toHaveBeenCalledWith(
      Product,
      { id: 'prod-1', tenantId: TENANT },
      { status: ProductStatus.DISCONTINUED },
    );
    expect(manager.update).toHaveBeenCalledWith(
      ProductVariant,
      { productId: 'prod-1', tenantId: TENANT },
      { status: VariantStatus.DISCONTINUED },
    );
  });
});
