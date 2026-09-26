import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud-controller.factory';
import { TaxCategory } from '../database/entities/tax-category.entity';
import { TaxCategoriesService } from './tax-categories.service';
import {
  CreateTaxCategoryDto,
  UpdateTaxCategoryDto,
} from './tax-categories.dto';

/**
 * Tax categories: products in a category are taxed at its rate (none = exempt).
 * Products without a category use the store's default tax rate.
 */
@ApiTags('Tax categories')
@ApiBearerAuth('JWT-auth')
@Controller('tax-categories')
export class TaxCategoriesController extends CrudController<TaxCategory>(
  CreateTaxCategoryDto,
  UpdateTaxCategoryDto,
  {
    entityType: 'tax_category',
    permission: 'pricing.manage',
    // The product form picks a tax category
    read: { anyOf: ['pricing.manage', 'catalog.manage'] },
  },
) {
  constructor(service: TaxCategoriesService) {
    super(service);
  }
}
