import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { PriceEntry } from '../database/entities/price-entry.entity';
import {
  PriceList,
  PriceListStatus,
  PriceListType,
} from '../database/entities/price-list.entity';
import { CustomerGroup } from '../database/entities/customer-group.entity';

// Lists that apply to every sale on their own (the others must be chosen)
const AUTOMATIC_TYPES = [PriceListType.STANDARD, PriceListType.PROMOTIONAL];

export interface PricingContext {
  branchId?: string | null;
  // Explicitly chosen list (e.g. wholesale); otherwise only standard/promotional lists apply
  priceListId?: string | null;
  quantity?: number;
  at?: Date;
}

/**
 * Resolves the selling price of variants.
 * The highest-priority active price list that has an entry wins; otherwise the variant's own price.
 */
@Injectable()
export class PricingService {
  constructor(
    @InjectRepository(PriceEntry)
    private entryRepository: Repository<PriceEntry>,
  ) {}

  async resolvePrices(
    tenantId: string,
    variants: Pick<ProductVariant, 'id' | 'price'>[],
    context: PricingContext = {},
  ): Promise<Map<string, number>> {
    const prices = new Map(variants.map((v) => [v.id, Number(v.price ?? 0)]));
    if (variants.length === 0) {
      return prices;
    }

    const at = context.at ?? new Date();
    const quantity = context.quantity ?? 1;

    const query = this.entryRepository
      .createQueryBuilder('entry')
      .innerJoin('entry.priceList', 'list')
      .where('entry.tenantId = :tenantId', { tenantId })
      .andWhere('entry.variantId IN (:...variantIds)', {
        variantIds: variants.map((v) => v.id),
      })
      .andWhere('list.status = :status', { status: PriceListStatus.ACTIVE })
      .andWhere('(list.validFrom IS NULL OR list.validFrom <= :at)', { at })
      .andWhere('(list.validTo IS NULL OR list.validTo >= :at)', { at })
      .andWhere('(entry.validFrom IS NULL OR entry.validFrom <= :at)', { at })
      .andWhere('(entry.validTo IS NULL OR entry.validTo >= :at)', { at })
      .andWhere(
        '(entry.minQuantity IS NULL OR entry.minQuantity <= :quantity)',
        { quantity },
      )
      .andWhere(
        new Brackets((qb) => {
          qb.where('list.priceListType IN (:...autoTypes)', {
            autoTypes: AUTOMATIC_TYPES,
          });
          if (context.priceListId) {
            qb.orWhere('list.id = :priceListId', {
              priceListId: context.priceListId,
            });
          }
        }),
      )
      .andWhere('(list.branchId IS NULL OR list.branchId = :branchId)', {
        branchId: context.branchId ?? null,
      })
      // Explicit list first, then priority, then the tightest quantity break
      .orderBy('CASE WHEN list.id = :chosen THEN 0 ELSE 1 END', 'ASC')
      .setParameter('chosen', context.priceListId ?? null)
      .addOrderBy('list.priority', 'DESC')
      .addOrderBy('entry.minQuantity', 'DESC', 'NULLS LAST');

    const entries = await query.getMany();
    const resolved = new Set<string>();
    for (const entry of entries) {
      if (!resolved.has(entry.variantId)) {
        prices.set(entry.variantId, Number(entry.price));
        resolved.add(entry.variantId);
      }
    }
    return prices;
  }

  /**
   * Whether selling at a chosen list's prices is a price change (needs
   * pos.price.override or a manager's approval): true unless the list applies
   * to everyone anyway (standard, promotional) or is the price list of the
   * customer's group. An unknown list prices nothing, so needs nothing.
   */
  async needsPriceOverride(
    tenantId: string,
    priceListId: string,
    customerGroupId: string | null,
  ): Promise<boolean> {
    const manager = this.entryRepository.manager;
    const list = await manager.findOne(PriceList, {
      where: { id: priceListId, tenantId },
      select: { id: true, priceListType: true },
    });
    if (!list || AUTOMATIC_TYPES.includes(list.priceListType)) return false;
    if (!customerGroupId) return true;
    const group = await manager.findOne(CustomerGroup, {
      where: { id: customerGroupId, tenantId },
      select: { id: true, priceListId: true },
    });
    return group?.priceListId !== priceListId;
  }
}
