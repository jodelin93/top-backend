import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Controller, Get, Param } from '@nestjs/common';
import { CrudController } from '../common/crud/crud-controller.factory';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { RequireAnyPermission } from '../auth/decorators/permissions.decorator';
import { Discount } from '../database/entities/discount.entity';
import { DiscountsService } from './discounts.service';
import { CreateDiscountDto, UpdateDiscountDto } from './discounts.dto';

@ApiTags('Discounts')
@ApiBearerAuth('JWT-auth')
@Controller('discounts')
export class DiscountsController extends CrudController<Discount>(
  CreateDiscountDto,
  UpdateDiscountDto,
  {
    entityType: 'discount',
    permission: 'discounts.manage',
    read: 'discounts.manage',
  },
) {
  constructor(private discountsService: DiscountsService) {
    super(discountsService);
  }

  /**
   * Check that a discount code can be used now
   * GET /discounts/code/:code
   */
  @Get('code/:code')
  @RequireAnyPermission('pos.sell', 'discounts.manage')
  lookup(@CurrentTenant() tenantId: string, @Param('code') code: string) {
    return this.discountsService.findUsableByCode(tenantId, code);
  }
}
