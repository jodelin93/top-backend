import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Controller,
  Get,
  Param,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { ReportsService } from './reports.service';
import { ReportRunnerService } from './report-runner.service';
import { ReconciliationReportService } from './reconciliation.service';
import { DailySummaryService } from './daily-summary.service';
import {
  DailySummaryQueryDto,
  ExportReportQueryDto,
  ReportQueryDto,
  RunReportQueryDto,
} from './reports.dto';
import { scopeOf } from './report-sql';
import { UserThrottle } from '../common/throttle/user-throttle.decorator';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('reports.view')
@ApiTags('Reports')
@ApiBearerAuth('JWT-auth')
@Controller('reports')
export class ReportsController {
  constructor(
    private reportsService: ReportsService,
    private runner: ReportRunnerService,
    private reconciliation: ReconciliationReportService,
    private dailySummary: DailySummaryService,
  ) {}

  /**
   * Dashboard figures
   * GET /reports/summary?from=&to=&timezone=&branchId=
   */
  @Get('summary')
  summary(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: ReportQueryDto,
  ) {
    return this.reportsService.summary(
      tenantId,
      query,
      user.permissions,
      scopeOf(user),
    );
  }

  /**
   * Printable end-of-day summary (PDF) for the store or one branch
   * GET /reports/daily-summary.pdf?date=YYYY-MM-DD&timezone=&branchId=
   */
  @Get('daily-summary.pdf')
  @UserThrottle()
  @RequirePermissions('reports.view', 'reports.export')
  async dailySummaryPdf(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: DailySummaryQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.dailySummary.pdf(
      tenantId,
      query,
      user.permissions,
      scopeOf(user),
    );
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    });
    return new StreamableFile(file.body);
  }

  /**
   * Available tabular reports
   * GET /reports/catalog
   */
  @Get('catalog')
  catalog(@CurrentUser() user: AuthUser) {
    return this.runner.catalog(user.permissions, scopeOf(user));
  }

  /**
   * Sales reconciliation checks
   * GET /reports/reconciliation?from=&to=
   */
  @Get('reconciliation')
  @UserThrottle()
  reconcile(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: ReportQueryDto,
  ) {
    return this.reconciliation.run(
      tenantId,
      query,
      scopeOf(user),
      user.permissions ?? [],
    );
  }

  /**
   * Download a report as CSV, Excel or PDF (small results; larger ones go
   * through POST /exports)
   * GET /reports/:key/export?format=csv|xlsx|pdf&from=&to=&timezone=&branchId=
   */
  @Get(':key/export')
  @UserThrottle()
  @RequirePermissions('reports.view', 'reports.export')
  async export(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
    @Query() query: ExportReportQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.runner.export(
      tenantId,
      key,
      query,
      query.format,
      user.permissions,
      scopeOf(user),
    );
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    });
    return new StreamableFile(file.body);
  }

  /**
   * Run one report
   * GET /reports/:key?from=&to=&timezone=
   */
  @Get(':key')
  @UserThrottle()
  run(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('key') key: string,
    @Query() query: RunReportQueryDto,
  ) {
    return this.runner.run(
      tenantId,
      key,
      query,
      user.permissions,
      scopeOf(user),
    );
  }
}
