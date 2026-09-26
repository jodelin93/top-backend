import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { EntityManager } from 'typeorm';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { SaleItemInput } from '../sales/sales.dto';
import { ReturnItemInput } from '../returns/returns.dto';
import { AdjustmentItemDto, CountEntryDto } from '../inventory/inventory.dto';
import {
  assertQuantitiesFit,
  assertUnitQuantities,
  catalogUnit,
  unitMetadata,
  unitOfVariant,
} from './variant-units';

const variant = (
  id: string,
  sku: string,
  unit: { code: string; allowsDecimals: boolean; precision: number } | null,
) => ({ id, sku, product: { unit } }) as unknown as ProductVariant;

const APPLES = variant('v-kg', 'APPLES', {
  code: 'kg',
  allowsDecimals: true,
  precision: 3,
});
const SOAP = variant('v-pc', 'SOAP', null);
const units = new Map([APPLES, SOAP].map((v) => [v.id, unitOfVariant(v)]));

describe('unit of a variant', () => {
  it('comes from the product unit; none = by the piece', () => {
    expect(unitOfVariant(APPLES)).toMatchObject({
      code: 'kg',
      allowsDecimals: true,
      precision: 3,
    });
    expect(unitOfVariant(SOAP)).toMatchObject({
      code: null,
      allowsDecimals: false,
      precision: 0,
    });
    expect(catalogUnit(unitOfVariant(SOAP))).toBeNull();
    expect(unitMetadata(unitOfVariant(APPLES))).toEqual({
      unit: 'kg',
      unitPrecision: 3,
    });
    expect(unitMetadata(unitOfVariant(SOAP))).toEqual({});
  });
});

describe('assertQuantitiesFit (decimal only for decimal units)', () => {
  it('accepts decimals up to the unit precision for measured items', () => {
    expect(() =>
      assertQuantitiesFit(units, [
        { variantId: 'v-kg', quantity: 1.25 },
        { variantId: 'v-kg', quantity: 0.005 },
        { variantId: 'v-pc', quantity: 3 },
      ]),
    ).not.toThrow();
  });

  it('refuses decimals for items sold by the piece', () => {
    expect(() =>
      assertQuantitiesFit(units, [{ variantId: 'v-pc', quantity: 1.5 }]),
    ).toThrow(new BadRequestException('SOAP: Quantity must be a whole number'));
  });

  it('refuses more decimals than the unit precision', () => {
    expect(() =>
      assertQuantitiesFit(units, [{ variantId: 'v-kg', quantity: 1.2505 }]),
    ).toThrow('APPLES: Quantity can have at most 3 decimals (kg)');
  });

  it('loads the units with the variants', async () => {
    const find = jest.fn(() => Promise.resolve([APPLES, SOAP]));
    const manager = { find } as unknown as EntityManager;
    await expect(
      assertUnitQuantities(manager, 't', [
        { variantId: 'v-kg', quantity: 1.25 },
      ]),
    ).resolves.toBeInstanceOf(Map);
    await expect(
      assertUnitQuantities(manager, 't', [
        { variantId: 'v-pc', quantity: 0.5 },
      ]),
    ).rejects.toThrow('SOAP: Quantity must be a whole number');
    expect(find).toHaveBeenCalledWith(
      ProductVariant,
      expect.objectContaining({ relations: { product: { unit: true } } }),
    );
  });
});

describe('quantity DTOs', () => {
  const errors = <T extends object>(cls: new () => T, body: object) =>
    validateSync(plainToInstance(cls, body) as object).flatMap((e) =>
      Object.keys(e.constraints ?? {}),
    );
  const uuid = '3f0a9a4e-7c5b-4f6f-9d2a-1b2c3d4e5f60';

  it('accept up to 4 decimals (the unit decides the rest)', () => {
    expect(errors(SaleItemInput, { variantId: uuid, quantity: 1.25 })).toEqual(
      [],
    );
    expect(errors(SaleItemInput, { variantId: uuid, quantity: 3 })).toEqual([]);
    expect(
      errors(SaleItemInput, { variantId: uuid, quantity: 1.23456 }),
    ).toContain('isNumber');
  });

  it('require quantities above zero (counts may be zero, deltas negative)', () => {
    expect(errors(SaleItemInput, { variantId: uuid, quantity: 0 })).toContain(
      'min',
    );
    expect(
      errors(ReturnItemInput, {
        saleItemId: uuid,
        quantity: -0.5,
        disposition: 'restock',
      }),
    ).toContain('min');
    expect(
      errors(CountEntryDto, { variantId: uuid, countedQuantity: 0 }),
    ).toEqual([]);
    expect(
      errors(AdjustmentItemDto, { variantId: uuid, quantity: -1.5 }),
    ).toEqual([]);
  });

  it('keep the till limit on sale quantities', () => {
    expect(
      errors(SaleItemInput, { variantId: uuid, quantity: 100001 }),
    ).toContain('max');
  });
});
