import { ConflictException, BadRequestException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ProductBarcode } from '../database/entities/product-barcode.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { AuditService } from '../audit/audit.service';
import {
  normalizeBarcode,
  ProductBarcodesService,
} from './product-barcodes.service';

const TENANT = 't1';

/** In-memory stand-ins for the two repositories the service touches */
function setup(
  rows: Partial<ProductBarcode>[],
  variants: Partial<ProductVariant>[],
) {
  const barcodes = rows.map((r, i) => ({
    id: `b${i}`,
    isPrimary: false,
    ...r,
  }));
  const matches = (row: object, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => {
      const actual = (row as Record<string, unknown>)[key];
      // typeorm Not(x) operator
      if (value && typeof value === 'object' && '_type' in value) {
        return actual !== (value as unknown as { _value: unknown })._value;
      }
      return actual === value;
    });
  const barcodeRepo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(barcodes.find((b) => matches(b, where)) ?? null),
    ),
    delete: jest.fn((where: Record<string, unknown>) => {
      for (let i = barcodes.length - 1; i >= 0; i--) {
        if (matches(barcodes[i], where)) barcodes.splice(i, 1);
      }
      return Promise.resolve();
    }),
    update: jest.fn((where: { id: string }, patch: object) => {
      Object.assign(
        barcodes.find((b) => b.id === where.id)!,
        patch,
      );
      return Promise.resolve();
    }),
    create: jest.fn((data: object) => data),
    save: jest.fn((data: Partial<ProductBarcode>) => {
      barcodes.push({
        id: `b${barcodes.length + 10}`,
        isPrimary: false,
        ...data,
      });
      return Promise.resolve(data);
    }),
    count: jest.fn(() => Promise.resolve(barcodes.length)),
  };
  const variantRepo = {
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(variants.find((v) => matches(v, where)) ?? null),
    ),
  };
  const getRepository = (entity: unknown) =>
    entity === ProductBarcode ? barcodeRepo : variantRepo;
  const manager = { getRepository } as unknown as EntityManager;
  const dataSource = {
    manager,
    transaction: (work: (m: EntityManager) => Promise<unknown>) =>
      work(manager),
    getRepository,
  } as unknown as DataSource;
  const service = new ProductBarcodesService(dataSource, {
    record: jest.fn(),
  } as unknown as AuditService);
  return { service, manager, barcodes };
}

describe('ProductBarcodesService', () => {
  const variants = [
    { id: 'v1', productId: 'p1', tenantId: TENANT, sku: 'MUG', barcode: '111' },
    { id: 'v2', productId: 'p2', tenantId: TENANT, sku: 'TEA', barcode: '999' },
  ];

  it('normalises barcodes', () => {
    expect(normalizeBarcode('  123 ')).toBe('123');
    expect(normalizeBarcode('   ')).toBeNull();
    expect(normalizeBarcode(undefined)).toBeNull();
  });

  it('replaces the primary row when the variant barcode changes', async () => {
    const { service, manager, barcodes } = setup(
      [{ tenantId: TENANT, variantId: 'v1', barcode: '111', isPrimary: true }],
      variants,
    );
    await service.syncPrimary(manager, TENANT, 'v1', ' 222 ');
    expect(barcodes).toEqual([
      expect.objectContaining({
        variantId: 'v1',
        barcode: '222',
        isPrimary: true,
      }),
    ]);
  });

  it('promotes an existing extra barcode instead of duplicating it', async () => {
    const { service, manager, barcodes } = setup(
      [
        { tenantId: TENANT, variantId: 'v1', barcode: '111', isPrimary: true },
        { tenantId: TENANT, variantId: 'v1', barcode: '333' },
      ],
      variants,
    );
    await service.syncPrimary(manager, TENANT, 'v1', '333');
    expect(barcodes).toEqual([
      expect.objectContaining({ barcode: '333', isPrimary: true }),
    ]);
  });

  it('clears the primary row when the barcode is removed', async () => {
    const { service, manager, barcodes } = setup(
      [
        { tenantId: TENANT, variantId: 'v1', barcode: '111', isPrimary: true },
        { tenantId: TENANT, variantId: 'v1', barcode: '333' },
      ],
      variants,
    );
    await service.syncPrimary(manager, TENANT, 'v1', null);
    expect(barcodes.map((b) => b.barcode)).toEqual(['333']);
  });

  it('leaves everything alone when the barcode is not being changed', async () => {
    const { service, manager, barcodes } = setup(
      [{ tenantId: TENANT, variantId: 'v1', barcode: '111', isPrimary: true }],
      variants,
    );
    await service.syncPrimary(manager, TENANT, 'v1', undefined);
    expect(barcodes).toHaveLength(1);
  });

  it('rejects a barcode that belongs to another variant (409)', async () => {
    const { service, manager } = setup(
      [{ tenantId: TENANT, variantId: 'v2', barcode: '555' }],
      variants,
    );
    await expect(
      service.syncPrimary(manager, TENANT, 'v1', '555'),
    ).rejects.toThrow(
      new ConflictException('Barcode 555 is already used by TEA'),
    );
    // ...including a legacy primary barcode not mirrored in product_barcodes yet
    await expect(service.add(TENANT, 'p1', 'v1', '999')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it("won't remove a variant's primary barcode as an extra one", async () => {
    const { service } = setup(
      [{ tenantId: TENANT, variantId: 'v1', barcode: '111', isPrimary: true }],
      variants,
    );
    await expect(
      service.remove(TENANT, 'p1', 'v1', 'b0'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
