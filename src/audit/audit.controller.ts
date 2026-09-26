import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { assertAllBranches } from '../auth/branch-scope';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { AuditService } from './audit.service';
import { AuditQueryDto } from './audit.dto';

@ApiTags('Audit')
@ApiBearerAuth('JWT-auth')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('audit.view')
@Controller('audit-logs')
export class AuditController {
  constructor(private auditService: AuditService) {}

  /**
   * The store's audit trail covers every branch (like the audit-activity
   * report): members limited to some branches can't read it (403).
   * GET /audit-logs?action=&entityType=&entityId=&actorId=&from=&to=&page=&limit=
   */
  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: AuditQueryDto,
  ) {
    assertAllBranches(user, 'The audit log needs access to every branch');
    return this.auditService.list(tenantId, query);
  }
}
