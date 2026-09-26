import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DeepPartial } from 'typeorm';
import { Category } from '../database/entities/category.entity';
import { CategoriesService } from './categories.service';

const TENANT = 'tenant-1';

describe('CategoriesService', () => {
  let service: CategoriesService;
  // A tiny in-memory tree: food > drinks > coffee, and a separate "toys"
  let rows: Map<string, Category>;
  const repository = {
    findOne: jest.fn(
      ({ where }: { where: { id: string; tenantId: string } }) => {
        const row = rows.get(where.id);
        return Promise.resolve(
          row && row.tenantId === where.tenantId ? row : null,
        );
      },
    ),
    create: jest.fn((data: DeepPartial<Category>) => data),
    save: jest.fn((entity: Category) => Promise.resolve(entity)),
  };

  const category = (id: string, parentId: string | null, tenantId = TENANT) =>
    ({ id, parentId, tenantId, code: id }) as Category;

  beforeEach(async () => {
    jest.clearAllMocks();
    rows = new Map(
      [
        category('food', null),
        category('drinks', 'food'),
        category('coffee', 'drinks'),
        category('toys', null),
        category('elsewhere', null, 'other-tenant'),
      ].map((c) => [c.id, c]),
    );
    const module = await Test.createTestingModule({
      providers: [
        CategoriesService,
        { provide: getRepositoryToken(Category), useValue: repository },
      ],
    }).compile();
    service = module.get(CategoriesService);
  });

  it('creates a root category without a parent', async () => {
    const created = await service.create(TENANT, { code: 'new' });
    expect(created).toMatchObject({ tenantId: TENANT, parent: null });
  });

  it('sets the parent relation so the tree path stays correct', async () => {
    const created = await service.create(TENANT, {
      code: 'tea',
      parentId: 'drinks',
    });
    expect(created.parent).toBe(rows.get('drinks'));
  });

  it('rejects a parent from another tenant', async () => {
    await expect(
      service.create(TENANT, { code: 'x', parentId: 'elsewhere' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('does not let a category be its own parent', async () => {
    await expect(
      service.update(TENANT, 'drinks', { parentId: 'drinks' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('does not let a category move under one of its descendants', async () => {
    await expect(
      service.update(TENANT, 'food', { parentId: 'coffee' }),
    ).rejects.toThrow('A category cannot be placed inside itself');
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('allows moving a category to another branch of the tree', async () => {
    const updated = await service.update(TENANT, 'coffee', {
      parentId: 'toys',
    });
    expect(updated.parent).toBe(rows.get('toys'));
  });

  it('allows moving a category back to the root', async () => {
    // The API accepts parentId: null (see UpdateCategoryDto) though the entity types it as string
    const updated = await service.update(TENANT, 'coffee', {
      parentId: null as unknown as string,
    });
    expect(updated.parent).toBeNull();
  });

  it('leaves the parent alone when parentId is not part of the update', async () => {
    await service.update(TENANT, 'coffee', { code: 'espresso' });
    // only the category itself is loaded, no ancestor walk
    expect(repository.findOne).toHaveBeenCalledTimes(1);
  });
});
