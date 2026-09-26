import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { TenantCrudService } from '../common/crud/tenant-crud.service';
import {
  CustomerFieldDefinition,
  CustomerFieldType,
} from '../database/entities/customer-field-definition.entity';
import { cleanValues } from '../products/variant-generator';

export const MAX_CUSTOMER_FIELDS = 30;

@Injectable()
export class CustomerFieldsService extends TenantCrudService<CustomerFieldDefinition> {
  protected readonly entityName = 'Customer field';
  protected readonly defaultOrder = {
    sortOrder: 'ASC' as const,
    label: 'ASC' as const,
  };

  constructor(
    @InjectRepository(CustomerFieldDefinition)
    repository: Repository<CustomerFieldDefinition>,
  ) {
    super(repository);
  }

  async create(tenantId: string, data: DeepPartial<CustomerFieldDefinition>) {
    const count = await this.repository.count({ where: { tenantId } });
    if (count >= MAX_CUSTOMER_FIELDS) {
      throw new BadRequestException(
        `A store can define at most ${MAX_CUSTOMER_FIELDS} customer fields`,
      );
    }
    return super.create(tenantId, this.normalize(data, data.fieldType));
  }

  async update(
    tenantId: string,
    id: string,
    data: DeepPartial<CustomerFieldDefinition>,
  ) {
    const current = await this.findOne(tenantId, id);
    return super.update(
      tenantId,
      id,
      this.normalize(
        data,
        data.fieldType ?? current.fieldType,
        current.options,
      ),
    );
  }

  // Select fields need options; other types don't keep any
  private normalize(
    data: DeepPartial<CustomerFieldDefinition>,
    fieldType: DeepPartial<CustomerFieldType> | undefined,
    currentOptions: string[] | null = null,
  ): DeepPartial<CustomerFieldDefinition> {
    if (fieldType !== CustomerFieldType.SELECT) {
      return { ...data, options: null };
    }
    const options =
      data.options !== undefined
        ? cleanValues(data.options ?? [])
        : (currentOptions ?? []);
    if (options.length === 0) {
      throw new BadRequestException('A select field needs at least one option');
    }
    return { ...data, options };
  }
}
