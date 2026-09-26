import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { TenantCrudService } from '../common/crud/tenant-crud.service';
import { Category } from '../database/entities/category.entity';

@Injectable()
export class CategoriesService extends TenantCrudService<Category> {
  protected readonly entityName = 'Category';
  protected readonly defaultOrder = {
    sortOrder: 'ASC' as const,
    code: 'ASC' as const,
  };

  constructor(@InjectRepository(Category) repository: Repository<Category>) {
    super(repository);
  }

  async create(tenantId: string, data: DeepPartial<Category>) {
    const parent = await this.resolveParent(tenantId, null, data.parentId);
    return super.create(tenantId, { ...data, parent } as DeepPartial<Category>);
  }

  async update(tenantId: string, id: string, data: DeepPartial<Category>) {
    if (data.parentId !== undefined) {
      const parent = await this.resolveParent(tenantId, id, data.parentId);
      data = { ...data, parent } as DeepPartial<Category>;
    }
    return super.update(tenantId, id, data);
  }

  // Validate the parent belongs to the tenant and doesn't create a cycle.
  // Setting the `parent` relation (not just parentId) keeps the tree path up to date.
  private async resolveParent(
    tenantId: string,
    categoryId: string | null,
    parentId: string | null | undefined,
  ): Promise<Category | null> {
    if (!parentId) {
      return null;
    }

    let current: Category | null = await this.findOne(tenantId, parentId);
    const parent = current;
    while (current) {
      if (current.id === categoryId) {
        throw new BadRequestException(
          'A category cannot be placed inside itself',
        );
      }
      current = current.parentId
        ? await this.repository.findOne({
            where: { id: current.parentId, tenantId },
          })
        : null;
    }
    return parent;
  }
}
