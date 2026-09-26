import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { TenantCrudService } from '../common/crud/tenant-crud.service';
import { TaxCategory } from '../database/entities/tax-category.entity';
import { TaxRate } from '../database/entities/tax-rate.entity';

@Injectable()
export class TaxCategoriesService extends TenantCrudService<TaxCategory> {
  protected readonly entityName = 'Tax category';
  protected readonly defaultOrder = { code: 'ASC' as const };

  constructor(
    @InjectRepository(TaxCategory) repository: Repository<TaxCategory>,
    @InjectRepository(TaxRate) private taxRates: Repository<TaxRate>,
  ) {
    super(repository);
  }

  findAll(tenantId: string): Promise<TaxCategory[]> {
    return this.repository.find({
      where: { tenantId },
      relations: { taxRate: true },
      order: this.defaultOrder,
    });
  }

  async create(tenantId: string, data: DeepPartial<TaxCategory>) {
    await this.assertRate(tenantId, data.taxRateId);
    return super.create(tenantId, data);
  }

  async update(tenantId: string, id: string, data: DeepPartial<TaxCategory>) {
    await this.assertRate(tenantId, data.taxRateId);
    // Drop the loaded relation so a changed taxRateId isn't overridden by it
    const saved = await super.update(tenantId, id, {
      ...data,
      taxRate: undefined,
    });
    return this.repository.findOneOrFail({
      where: { id: saved.id, tenantId },
      relations: { taxRate: true },
    });
  }

  // The rate must belong to the same store
  private async assertRate(tenantId: string, taxRateId?: string | null) {
    if (!taxRateId) return;
    const exists = await this.taxRates.exists({
      where: { id: taxRateId, tenantId },
    });
    if (!exists) {
      throw new BadRequestException('Tax rate not found');
    }
  }
}
