import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { TaxCategory } from '../database/entities/tax-category.entity';
import { TaxRateStatus } from '../database/entities/tax-rate.entity';
import { SettingsService } from '../settings/settings.service';

export interface TaxCategoryRate {
  taxRateId: string | null;
  rate: number | null;
  active: boolean;
}

/**
 * Tax rate of one product (R031):
 * - no tax category → the store's default rate
 * - category without a tax rate → exempt (0%)
 * - category with an active rate → that rate
 * - category whose rate was deactivated → the store default (never silently exempt)
 */
export function taxRateFor(
  taxCategoryId: string | null | undefined,
  categories: Map<string, TaxCategoryRate>,
  defaultRate: number,
): number {
  if (!taxCategoryId) return defaultRate;
  const category = categories.get(taxCategoryId);
  if (!category) return defaultRate;
  if (!category.taxRateId) return 0;
  return category.active && category.rate != null
    ? Number(category.rate)
    : defaultRate;
}

@Injectable()
export class TaxResolverService {
  constructor(
    private dataSource: DataSource,
    private settingsService: SettingsService,
  ) {}

  /**
   * Store default rate plus a resolver for each product's tax category
   */
  async load(
    tenantId: string,
    taxCategoryIds: (string | null | undefined)[],
  ): Promise<{
    defaultRate: number;
    rateFor: (taxCategoryId: string | null | undefined) => number;
  }> {
    const defaultTax = await this.settingsService.getDefaultTaxRate(tenantId);
    const defaultRate = defaultTax ? Number(defaultTax.rate) : 0;

    const ids = [...new Set(taxCategoryIds.filter((id): id is string => !!id))];
    const categories = new Map<string, TaxCategoryRate>();
    if (ids.length > 0) {
      const rows = await this.dataSource.getRepository(TaxCategory).find({
        where: { tenantId, id: In(ids) },
        relations: { taxRate: true },
      });
      for (const row of rows) {
        categories.set(row.id, {
          taxRateId: row.taxRateId,
          rate: row.taxRate ? Number(row.taxRate.rate) : null,
          active: row.taxRate?.status === TaxRateStatus.ACTIVE,
        });
      }
    }

    return {
      defaultRate,
      rateFor: (taxCategoryId) =>
        taxRateFor(taxCategoryId, categories, defaultRate),
    };
  }
}
