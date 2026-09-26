import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';
import { TenantCrudService } from '../common/crud/tenant-crud.service';
import {
  Discount,
  DiscountScope,
  DiscountStatus,
  DiscountType,
} from '../database/entities/discount.entity';

@Injectable()
export class DiscountsService extends TenantCrudService<Discount> {
  protected readonly entityName = 'Discount';
  protected readonly defaultOrder = {
    priority: 'DESC' as const,
    code: 'ASC' as const,
  };

  constructor(@InjectRepository(Discount) repository: Repository<Discount>) {
    super(repository);
  }

  async create(tenantId: string, data: DeepPartial<Discount>) {
    this.validateShape({ ...data } as Discount);
    return super.create(tenantId, {
      ...data,
      code: String(data.code).toUpperCase(),
    });
  }

  async update(tenantId: string, id: string, data: DeepPartial<Discount>) {
    const current = await this.findOne(tenantId, id);
    this.validateShape({ ...current, ...data } as Discount);
    if (data.code) {
      data = { ...data, code: String(data.code).toUpperCase() };
    }
    return super.update(tenantId, id, data);
  }

  /**
   * Find a discount code that can be used right now
   */
  async findUsableByCode(tenantId: string, code: string): Promise<Discount> {
    const discount = await this.repository.findOne({
      where: { tenantId, code: code.trim().toUpperCase() },
    });
    if (!discount) {
      throw new NotFoundException(`Discount code ${code} not found`);
    }

    const now = new Date();
    if (discount.status !== DiscountStatus.ACTIVE) {
      throw new BadRequestException('This discount is not active');
    }
    if (discount.validFrom && new Date(discount.validFrom) > now) {
      throw new BadRequestException('This discount has not started yet');
    }
    if (discount.validTo && new Date(discount.validTo) < now) {
      throw new BadRequestException('This discount has expired');
    }
    if (
      discount.usageLimit != null &&
      discount.usageCount >= discount.usageLimit
    ) {
      throw new BadRequestException(
        'This discount has reached its usage limit',
      );
    }
    return discount;
  }

  // Make sure the fields needed by the discount type are present
  private validateShape(d: Discount) {
    if (d.discountType === DiscountType.PERCENTAGE && d.percentage == null) {
      throw new BadRequestException('Percentage discounts need a percentage');
    }
    if (d.discountType === DiscountType.FIXED_AMOUNT && d.value == null) {
      throw new BadRequestException('Fixed amount discounts need a value');
    }
    if (d.discountType === DiscountType.BUY_X_GET_Y) {
      if (!d.buyQuantity || !d.getQuantity) {
        throw new BadRequestException(
          'Buy X get Y discounts need buy and get quantities',
        );
      }
      if (d.scope === DiscountScope.CART) {
        throw new BadRequestException(
          'Buy X get Y discounts apply to products or categories',
        );
      }
    }
    if (d.scope === DiscountScope.PRODUCT && !d.applicableProductIds?.length) {
      throw new BadRequestException(
        'Product discounts need at least one product',
      );
    }
    if (
      d.scope === DiscountScope.CATEGORY &&
      !d.applicableCategoryIds?.length
    ) {
      throw new BadRequestException(
        'Category discounts need at least one category',
      );
    }
  }
}
