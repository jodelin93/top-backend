import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller } from '@nestjs/common';
import { CrudController } from '../common/crud/crud-controller.factory';
import { AttributeDefinition } from '../database/entities/attribute-definition.entity';
import { AttributesService } from './attributes.service';
import { CreateAttributeDto, UpdateAttributeDto } from './attributes.dto';

/** Product attribute definitions (Size, Colour, ...) used to generate variants */
@ApiTags('Products')
@ApiBearerAuth('JWT-auth')
@Controller('attributes')
export class AttributesController extends CrudController<AttributeDefinition>(
  CreateAttributeDto,
  UpdateAttributeDto,
  {
    entityType: 'attribute',
    permission: 'catalog.manage',
    read: 'catalog.manage',
  },
) {
  constructor(service: AttributesService) {
    super(service);
  }
}
