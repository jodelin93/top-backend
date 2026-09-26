import { AuditService } from '../audit/audit.service';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { TenantCrudService } from '../common/crud/tenant-crud.service';
import { PriceList } from '../database/entities/price-list.entity';
import { PriceEntry } from '../database/entities/price-entry.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { SetPriceEntriesDto } from './price-lists.dto';

@Injectable()
export class PriceListsService extends TenantCrudService<PriceList> {
  protected readonly entityName = 'Price list';
  protected readonly defaultOrder = {
    priority: 'DESC' as const,
    code: 'ASC' as const,
  };

  constructor(
    @InjectRepository(PriceList) repository: Repository<PriceList>,
    @InjectRepository(PriceEntry)
    private entryRepository: Repository<PriceEntry>,
    @InjectRepository(ProductVariant)
    private variantRepository: Repository<ProductVariant>,
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {
    super(repository);
  }

  async getEntries(tenantId: string, priceListId: string) {
    await this.findOne(tenantId, priceListId);
    return this.entryRepository.find({
      where: { tenantId, priceListId },
      relations: { variant: { product: true } },
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Insert or update prices for the given variants (other entries are kept)
   */
  async setEntries(
    tenantId: string,
    priceListId: string,
    dto: SetPriceEntriesDto,
  ) {
    await this.findOne(tenantId, priceListId);

    const variantIds = [...new Set(dto.entries.map((e) => e.variantId))];
    if (variantIds.length !== dto.entries.length) {
      throw new BadRequestException('Each variant can only appear once');
    }
    const found = await this.variantRepository.count({
      where: { tenantId, id: In(variantIds) },
    });
    if (found !== variantIds.length) {
      throw new NotFoundException('One or more variants were not found');
    }

    await this.dataSource.transaction(async (manager) => {
      const existing = await manager.find(PriceEntry, {
        where: { tenantId, priceListId, variantId: In(variantIds) },
      });
      const byVariant = new Map(existing.map((e) => [e.variantId, e]));

      const rows = dto.entries.map((input) =>
        manager.create(PriceEntry, {
          ...byVariant.get(input.variantId),
          tenantId,
          priceListId,
          variantId: input.variantId,
          price: input.price,
          compareAtPrice: input.compareAtPrice ?? (null as unknown as number),
          minQuantity: input.minQuantity ?? (null as unknown as number),
        }),
      );
      await manager.save(rows);
      await this.auditService.record(
        {
          tenantId,
          action: 'price_list.prices_set',
          entityType: 'price_list',
          entityId: priceListId,
          changes: { before: existing, after: dto.entries },
        },
        manager,
      );
    });

    return this.getEntries(tenantId, priceListId);
  }

  async removeEntry(tenantId: string, priceListId: string, entryId: string) {
    const result = await this.entryRepository.delete({
      id: entryId,
      priceListId,
      tenantId,
    });
    if (!result.affected) {
      throw new NotFoundException('Price entry not found');
    }
    await this.auditService.record({
      tenantId,
      action: 'price_list.price_removed',
      entityType: 'price_list',
      entityId: priceListId,
      metadata: { entryId },
    });
  }
}
