import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud-controller.factory';
import { Category } from '../database/entities/category.entity';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto, UpdateCategoryDto } from './categories.dto';

@ApiTags('Categories')
@ApiBearerAuth('JWT-auth')
@Controller('categories')
export class CategoriesController extends CrudController<Category>(
  CreateCategoryDto,
  UpdateCategoryDto,
  {
    entityType: 'category',
    permission: 'catalog.manage',
    // Browsed at the till, in stock counts, discounts...
    read: 'anyMember',
  },
) {
  constructor(service: CategoriesService) {
    super(service);
  }
}
