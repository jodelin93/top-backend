import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { existsSync } from 'fs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { scopeOf } from '../reports/report-sql';
import { CONTENT_TYPES } from '../reports/report-files';
import { ExportsService } from './exports.service';
import { SavedFiltersService } from './saved-filters.service';
import { UserThrottle } from '../common/throttle/user-throttle.decorator';
import {
  CreateExportDto,
  ListSavedFiltersQueryDto,
  SaveReportFilterDto,
} from './exports.dto';

/**
 * Background report exports (spec §14)
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('reports.view', 'reports.export')
@ApiTags('Reports')
@ApiBearerAuth('JWT-auth')
@Controller('exports')
export class ExportsController {
  constructor(private exports: ExportsService) {}

  /**
   * Queue an export
   * POST /exports { reportKey, format: csv|xlsx|pdf, params: { from, to, timezone, branchId, … } }
   */
  @Post()
  @UserThrottle()
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateExportDto,
  ) {
    return this.exports.create(
      tenantId,
      user.id,
      dto,
      user.permissions,
      scopeOf(user),
    );
  }

  /** GET /exports: my exports of the last 7 days */
  @Get()
  list(@CurrentTenant() tenantId: string, @CurrentUser() user: AuthUser) {
    return this.exports.list(tenantId, user.id);
  }

  /**
   * Status, and a short-lived download link once the file is ready (the
   * permission is checked again here)
   * GET /exports/:id
   */
  @Get(':id')
  get(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.exports.get(
      tenantId,
      user.id,
      id,
      user.permissions,
      scopeOf(user),
    );
  }

  /** DELETE /exports/:id */
  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.exports.remove(tenantId, user.id, id);
  }
}

/**
 * The file behind a signed download link (local storage; S3 links go straight
 * to the bucket). No login: the link itself is the short-lived credential,
 * issued by GET /exports/:id after the permission check.
 */
@ApiTags('Reports')
@Public()
@Controller('exports/download')
export class ExportDownloadController {
  constructor(private exports: ExportsService) {}

  @Get(':token')
  @ApiExcludeEndpoint()
  async download(@Param('token') token: string, @Res() res: Response) {
    const file = await this.exports.resolveDownload(token);
    if (!existsSync(file.path)) throw new NotFoundException('File not found');
    res.setHeader('Content-Type', CONTENT_TYPES[file.format]);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${file.fileName.replace(/["\\\r\n]/g, '')}"`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.sendFile(file.path, { dotfiles: 'deny' });
  }
}

/**
 * Saved report filters
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('reports.view')
@ApiTags('Reports')
@ApiBearerAuth('JWT-auth')
@Controller('report-filters')
export class SavedFiltersController {
  constructor(private filters: SavedFiltersService) {}

  /** GET /report-filters?reportKey= — mine and shared ones */
  @Get()
  list(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: ListSavedFiltersQueryDto,
  ) {
    return this.filters.list(tenantId, user.id, query.reportKey);
  }

  @Post()
  create(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: SaveReportFilterDto,
  ) {
    return this.filters.create(tenantId, user.id, dto);
  }

  @Put(':id')
  update(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveReportFilterDto,
  ) {
    return this.filters.update(tenantId, user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.filters.remove(tenantId, user.id, id);
  }
}
