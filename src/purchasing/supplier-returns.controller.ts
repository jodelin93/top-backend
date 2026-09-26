import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { SupplierReturnsService } from './supplier-returns.service';
import {
  CreateSupplierReturnDto,
  SupplierDocumentsQueryDto,
} from './purchasing.dto';

/**
 * Supplier returns: goods sent back from a receipt (stock decrease + supplier credit)
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Purchasing')
@ApiBearerAuth('JWT-auth')
@Controller('supplier-returns')
export class SupplierReturnsController {
  constructor(private supplierReturnsService: SupplierReturnsService) {}

  @Get()
  @RequireAnyPermission('purchasing.manage', 'purchasing.payables')
  list(
    @CurrentTenant() tenantId: string,
    @Query() query: SupplierDocumentsQueryDto,
  ) {
    return this.supplierReturnsService.list(tenantId, query);
  }

  @Get(':id')
  @RequireAnyPermission('purchasing.manage', 'purchasing.payables')
  get(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.supplierReturnsService.get(tenantId, id);
  }

  @Post()
  @RequirePermissions('purchasing.manage')
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSupplierReturnDto,
  ) {
    return this.supplierReturnsService.create(tenantId, user.id, dto);
  }
}
