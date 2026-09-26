import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { TenantCrudService } from '../common/crud/tenant-crud.service';
import { CustomerGroup } from '../database/entities/customer-group.entity';
import { PriceList } from '../database/entities/price-list.entity';

@Injectable()
export class CustomerGroupsService extends TenantCrudService<CustomerGroup> {
  protected readonly entityName = 'Customer group';
  protected readonly defaultOrder = { name: 'ASC' as const };

  constructor(
    @InjectRepository(CustomerGroup) repository: Repository<CustomerGroup>,
    @InjectRepository(PriceList) private priceLists: Repository<PriceList>,
  ) {
    super(repository);
  }

  async create(tenantId: string, data: DeepPartial<CustomerGroup>) {
    await this.assertPriceList(tenantId, data.priceListId);
    return super.create(tenantId, data);
  }

  async update(tenantId: string, id: string, data: DeepPartial<CustomerGroup>) {
    await this.assertPriceList(tenantId, data.priceListId);
    return super.update(tenantId, id, data);
  }

  private async assertPriceList(tenantId: string, priceListId?: string | null) {
    if (!priceListId) return;
    const exists = await this.priceLists.exists({
      where: { id: priceListId, tenantId },
    });
    if (!exists) {
      throw new BadRequestException('Price list not found');
    }
  }
}
