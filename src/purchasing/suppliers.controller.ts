import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CrudController } from '../common/crud/crud-controller.factory';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { Supplier } from '../database/entities/supplier.entity';
import {
  CreateSupplierDto,
  SaveSupplierProductsDto,
  UpdateSupplierDto,
} from './purchasing.dto';
import { SuppliersService } from './suppliers.service';

/**
 * Suppliers (R070): GET/POST /suppliers, GET/PATCH/DELETE /suppliers/:id.
 * A supplier with purchase orders cannot be deleted (409): set it inactive.
 * GET/PUT /suppliers/:id/products: the supplier's codes, costs and minimums.
 */
@ApiTags('Purchasing')
@ApiBearerAuth('JWT-auth')
@Controller('suppliers')
export class SuppliersController extends CrudController<Supplier>(
  CreateSupplierDto,
  UpdateSupplierDto,
  {
    entityType: 'supplier',
    permission: 'purchasing.manage',
    read: { anyOf: ['purchasing.manage', 'purchasing.approve'] },
  },
) {
  constructor(private suppliersService: SuppliersService) {
    super(suppliersService);
  }

  @Get(':id/products')
  @RequireAnyPermission('purchasing.manage', 'purchasing.approve')
  listProducts(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.suppliersService.listProducts(tenantId, id);
  }

  // Replaces the whole list
  @Put(':id/products')
  @RequirePermissions('purchasing.manage')
  saveProducts(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveSupplierProductsDto,
  ) {
    return this.suppliersService.saveProducts(tenantId, id, dto);
  }
}
