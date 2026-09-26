import { BadRequestException } from '@nestjs/common';
import { EntityManager, In } from 'typeorm';
import { ProductVariant } from '../database/entities/product-variant.entity';
import {
  PIECE_UNIT,
  quantityError,
  QuantityUnit,
} from '../common/utils/quantity';

export interface VariantUnit extends QuantityUnit {
  variantId: string;
  sku: string;
}

/**
 * Unit of a variant loaded with `product.unit` (none = sold by the piece).
 * An inactive unit still decides how the item is counted.
 */
export function unitOfVariant(
  variant: Pick<ProductVariant, 'id' | 'sku' | 'product'> | null | undefined,
): VariantUnit {
  const unit = variant?.product?.unit;
  return {
    variantId: variant?.id ?? '',
    sku: variant?.sku ?? '',
    code: unit?.code ?? null,
    allowsDecimals: !!unit?.allowsDecimals,
    precision: unit?.allowsDecimals ? Number(unit.precision ?? 0) : 0,
  };
}

/** Relations to load with variants so unitOfVariant() knows their unit */
export const VARIANT_UNIT_RELATIONS = { product: { unit: true } } as const;

/**
 * The unit each variant is sold in (its product's unit; none = by the piece).
 * Variants that don't exist are left out.
 */
export async function loadVariantUnits(
  manager: EntityManager,
  tenantId: string,
  variantIds: string[],
): Promise<Map<string, VariantUnit>> {
  const ids = [...new Set(variantIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const variants = await manager.find(ProductVariant, {
    where: { tenantId, id: In(ids) },
    relations: VARIANT_UNIT_RELATIONS,
  });
  return new Map(
    (variants ?? []).map((v) => [v.id, unitOfVariant(v)] as const),
  );
}

/**
 * Check every line's quantity against its unit (spec §5/§7): decimals only for
 * units that allow them, with at most the unit's precision; whole units (≥ 1)
 * otherwise. Throws 400 naming the SKU.
 */
export function assertQuantitiesFit(
  units: Map<string, VariantUnit>,
  lines: { variantId: string; quantity: number | null | undefined }[],
  options: { allowZero?: boolean } = {},
): void {
  for (const line of lines) {
    if (line.quantity === null || line.quantity === undefined) continue;
    const unit = units.get(line.variantId);
    const error = quantityError(
      Number(line.quantity),
      unit ?? PIECE_UNIT,
      options,
    );
    if (error) {
      throw new BadRequestException(`${unit?.sku || line.variantId}: ${error}`);
    }
  }
}

/** loadVariantUnits + assertQuantitiesFit; returns the units for later use */
export async function assertUnitQuantities(
  manager: EntityManager,
  tenantId: string,
  lines: { variantId: string; quantity: number | null | undefined }[],
  options: { allowZero?: boolean } = {},
): Promise<Map<string, VariantUnit>> {
  const units = await loadVariantUnits(
    manager,
    tenantId,
    lines.map((l) => l.variantId),
  );
  assertQuantitiesFit(units, lines, options);
  return units;
}

/**
 * What a sale line keeps of its unit (snapshot, like the product name):
 * { unit: "kg", unitPrecision: 3 } for measured items, nothing for pieces.
 */
export function unitMetadata(unit: QuantityUnit | null | undefined): {
  unit?: string;
  unitPrecision?: number;
} {
  if (!unit?.allowsDecimals) return {};
  return {
    ...(unit.code ? { unit: unit.code } : {}),
    unitPrecision: unit.precision,
  };
}

/** Unit as sent to the POS (catalog items, resumed carts); null = by the piece */
export interface CatalogUnit {
  code: string | null;
  allowsDecimals: boolean;
  precision: number;
}

export function catalogUnit(
  unit: QuantityUnit | null | undefined,
): CatalogUnit | null {
  if (!unit || (!unit.allowsDecimals && !unit.code)) return null;
  return {
    code: unit.code ?? null,
    allowsDecimals: !!unit.allowsDecimals,
    precision: unit.allowsDecimals ? unit.precision : 0,
  };
}
