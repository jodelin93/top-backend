import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireAnyPermission } from '../auth/decorators/permissions.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { ConflictCasesService } from './conflict-cases.service';
import { ListConflictCasesQueryDto, ResolveConflictCaseDto } from './sales.dto';

/**
 * Review queue. Each kind of case is worked by its own people (see
 * CASE_PERMISSIONS): stock (inventory.adjust) fixes oversells, sales.review
 * offline prices and leases, shifts.manage late or shift-less cash. Everyone
 * sees and closes only their kinds.
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Review queue')
@ApiBearerAuth('JWT-auth')
@Controller('conflict-cases')
export class ConflictCasesController {
  constructor(private conflictCases: ConflictCasesService) {}

  /**
   * GET /conflict-cases?status=open&type=&saleId=&page=&limit=
   */
  @Get()
  @RequireAnyPermission('sales.review', 'inventory.adjust', 'shifts.manage')
  findAll(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: ListConflictCasesQueryDto,
  ) {
    return this.conflictCases.findAll(tenantId, query, user.permissions);
  }

  /**
   * GET /conflict-cases/open-count
   */
  @Get('open-count')
  @RequireAnyPermission('sales.review', 'inventory.adjust', 'shifts.manage')
  async openCount(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
  ) {
    return {
      open: await this.conflictCases.countOpen(tenantId, user.permissions),
    };
  }

  /**
   * Close a case with a note: resolved (fixed) or dismissed (nothing to do)
   * POST /conflict-cases/:id/resolve
   */
  @Post(':id/resolve')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission('sales.review', 'inventory.adjust', 'shifts.manage')
  resolve(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveConflictCaseDto,
  ) {
    return this.conflictCases.resolve(tenantId, user, id, dto);
  }
}
