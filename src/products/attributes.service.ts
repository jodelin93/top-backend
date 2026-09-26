import { ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { TenantCrudService } from '../common/crud/tenant-crud.service';
import {
  AttributeDefinition,
  AttributeType,
} from '../database/entities/attribute-definition.entity';
import { AttributeValue } from '../database/entities/attribute-value.entity';
import { cleanValues } from './variant-generator';

@Injectable()
export class AttributesService extends TenantCrudService<AttributeDefinition> {
  protected readonly entityName = 'Attribute';
  protected readonly defaultOrder = {
    sortOrder: 'ASC' as const,
    code: 'ASC' as const,
  };

  constructor(
    @InjectRepository(AttributeDefinition)
    repository: Repository<AttributeDefinition>,
    @InjectRepository(AttributeValue)
    private values: Repository<AttributeValue>,
  ) {
    super(repository);
  }

  create(tenantId: string, data: DeepPartial<AttributeDefinition>) {
    // DTO instances carry unset fields as undefined, so default them explicitly
    return super.create(tenantId, {
      ...data,
      attributeType: data.attributeType ?? AttributeType.SELECT,
      isVariantDefining: data.isVariantDefining ?? true,
      options: data.options ? cleanValues(data.options) : null,
    });
  }

  update(tenantId: string, id: string, data: DeepPartial<AttributeDefinition>) {
    return super.update(tenantId, id, {
      ...data,
      ...(data.options !== undefined && {
        options: data.options ? cleanValues(data.options) : null,
      }),
    });
  }

  // Deleting would silently strip the attribute from existing variants
  async remove(tenantId: string, id: string): Promise<void> {
    await this.findOne(tenantId, id);
    const used = await this.values.count({
      where: { tenantId, attributeId: id },
    });
    if (used > 0) {
      throw new ConflictException(
        `This attribute is used by ${used} variant(s) and cannot be deleted`,
      );
    }
    return super.remove(tenantId, id);
  }
}
