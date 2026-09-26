import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ReorderService } from './reorder.service';
import { ReorderQueryDto } from './purchasing.dto';

/**
 * Reorder suggestions, grouped by preferred supplier. A group becomes a draft
 * purchase order with POST /purchase-orders.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Purchasing')
@ApiBearerAuth('JWT-auth')
@Controller('purchasing/reorder-suggestions')
export class ReorderController {
  constructor(private reorderService: ReorderService) {}

  @Get()
  @RequirePermissions('purchasing.manage')
  suggestions(
    @CurrentTenant() tenantId: string,
    @Query() query: ReorderQueryDto,
  ) {
    return this.reorderService.suggestions(tenantId, query);
  }
}
