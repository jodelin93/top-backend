import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, FindOptionsWhere, In, Repository } from 'typeorm';
import { scopedBranchIds } from '../auth/branch-scope';
import { Branch } from '../database/entities/branch.entity';
import { categoryVisibleWhere, isCategoryVisible } from './category-branches';
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

  /** A branch-limited user (a cashier of one shop) sees their branches' categories */
  findAll(
    tenantId: string,
    where: FindOptionsWhere<Category> = {},
  ): Promise<Category[]> {
    return super.findAll(tenantId, { ...where, ...categoryVisibleWhere() });
  }

  async findOne(tenantId: string, id: string): Promise<Category> {
    const category = await super.findOne(tenantId, id);
    if (!isCategoryVisible(category)) {
      throw new NotFoundException('Category not found');
    }
    return category;
  }

  async create(tenantId: string, data: DeepPartial<Category>) {
    const parent = await this.resolveParent(tenantId, null, data.parentId);
    // Made by someone limited to some branches: shown in those, unless they chose
    const branchIds = await this.checkBranches(
      tenantId,
      data.branchIds ?? (scopedBranchIds() ? [...scopedBranchIds()!] : null),
    );
    return super.create(tenantId, {
      ...data,
      parent,
      branchIds,
    } as DeepPartial<Category>);
  }

  async update(tenantId: string, id: string, data: DeepPartial<Category>) {
    if (data.parentId !== undefined) {
      const parent = await this.resolveParent(tenantId, id, data.parentId);
      data = { ...data, parent } as DeepPartial<Category>;
    }
    if (data.branchIds !== undefined) {
      data = {
        ...data,
        branchIds: await this.checkBranches(tenantId, data.branchIds),
      };
    }
    return super.update(tenantId, id, data);
  }

  /**
   * Branches of the store, without repeats; none = every branch. Someone
   * limited to some branches can only tie a category to those.
   */
  private async checkBranches(
    tenantId: string,
    branchIds: string[] | null | undefined,
  ): Promise<string[] | null> {
    const unique = [...new Set(branchIds ?? [])];
    const scope = scopedBranchIds();
    if (!unique.length) {
      if (scope)
        throw new ForbiddenException(
          'Tie the category to your branches: you cannot show it in every branch',
        );
      return null;
    }
    if (scope && unique.some((b) => !scope.includes(b))) {
      throw new ForbiddenException('You can only choose your own branches');
    }
    const found = await this.repository.manager.count(Branch, {
      where: { tenantId, id: In(unique) },
    });
    if (found !== unique.length)
      throw new BadRequestException('Unknown branch');
    return unique.sort();
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
