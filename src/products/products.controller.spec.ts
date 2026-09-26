import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import { ProductsController } from './products.controller';
import { ProductsService } from './products.service';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { ApprovalsService } from '../approvals/approvals.service';

describe('ProductsController', () => {
  let controller: ProductsController;
  const productsService = {
    findAll: jest.fn(),
    create: jest.fn(),
    createVariant: jest.fn(),
    remove: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      controllers: [ProductsController],
      providers: [
        { provide: ProductsService, useValue: productsService },
        PermissionsGuard,
        { provide: ApprovalsService, useValue: { verify: jest.fn() } },
        Reflector,
      ],
    }).compile();
    controller = module.get(ProductsController);
  });

  it('lists products for the current tenant with the filters', async () => {
    productsService.findAll.mockResolvedValue([]);
    await controller.findAll('t1', { search: 'mug' });
    expect(productsService.findAll).toHaveBeenCalledWith('t1', {
      search: 'mug',
    });
  });

  it('creates a variant under the product from the URL', async () => {
    await controller.createVariant('t1', 'prod-1', {
      sku: 'MUG-RED',
    });
    expect(productsService.createVariant).toHaveBeenCalledWith('t1', {
      sku: 'MUG-RED',
      productId: 'prod-1',
    });
  });

  it('removes within the tenant', async () => {
    await controller.remove('t1', 'prod-1');
    expect(productsService.remove).toHaveBeenCalledWith('t1', 'prod-1');
  });
});
