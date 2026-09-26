import { EntityManager } from 'typeorm';
import {
  Product,
  ProductStatus,
  ProductType,
} from '../database/entities/product.entity';
import {
  ProductVariant,
  VariantStatus,
} from '../database/entities/product-variant.entity';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { CalcLineResult, CalcResult } from './sale-calculator';

/**
 * Gift cards sold at the till are sale lines of a system product "Gift card"
 * (created on first use, inactive so it never shows in the catalog, not stock
 * tracked). They are a liability, not revenue: no tax, no discount, and the
 * line carries metadata.storedValue = true so reports leave it out of net sales.
 */
export const GIFT_CARD_SKU = 'SYS-GIFT-CARD';
export const GIFT_CARD_LINE_PREFIX = 'gc';

export const isGiftCardLineKey = (key: string) =>
  key.startsWith(GIFT_CARD_LINE_PREFIX);

/** Append gift card lines (amount = subtotal = total) to a priced cart */
export function withGiftCardLines(
  calc: CalcResult,
  cards: { amount: number }[],
  productId: string,
): CalcResult {
  if (!cards.length) return calc;
  const lines: CalcLineResult[] = cards.map((card, index) => ({
    key: `${GIFT_CARD_LINE_PREFIX}${index}`,
    productId,
    categoryId: null,
    quantity: 1,
    unitPrice: card.amount,
    taxRate: 0,
    subtotal: card.amount,
    discountAmount: 0,
    taxAmount: 0,
    total: card.amount,
  }));
  const cents = (v: number) => Math.round(v * 100);
  const extra = cards.reduce((sum, c) => sum + cents(c.amount), 0);
  return {
    ...calc,
    lines: [...calc.lines, ...lines],
    subtotal: (cents(calc.subtotal) + extra) / 100,
    total: (cents(calc.total) + extra) / 100,
  };
}

/** The "Gift card" system variant (with its product), created on first use */
export async function ensureGiftCardVariant(
  manager: EntityManager,
  tenantId: string,
): Promise<ProductVariant> {
  const find = () =>
    manager.findOne(ProductVariant, {
      where: { tenantId, sku: GIFT_CARD_SKU },
      relations: { product: true },
    });
  const existing = await find();
  if (existing) return existing;
  try {
    await manager.transaction(async (tx) => {
      const product = await tx.save(
        tx.create(Product, {
          tenantId,
          sku: GIFT_CARD_SKU,
          name: { en: 'Gift card', fr: 'Carte cadeau' },
          productType: ProductType.SIMPLE,
          isStockTracked: false,
          isSerialized: false,
          allowBackorder: false,
          status: ProductStatus.INACTIVE,
          metadata: { system: 'gift_card' },
        }),
      );
      await tx.save(
        tx.create(ProductVariant, {
          tenantId,
          productId: product.id,
          sku: GIFT_CARD_SKU,
          price: 0,
          status: VariantStatus.INACTIVE,
          metadata: { system: 'gift_card' },
        }),
      );
    });
  } catch (error) {
    if (!isPgError(error, PG_UNIQUE_VIOLATION)) throw error;
  }
  const created = await find();
  if (!created) throw new Error('Gift card product could not be created');
  return created;
}
