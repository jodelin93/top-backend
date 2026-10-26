import { ApiBearerAuth, ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { IsIn, IsOptional } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { hiddenFieldsFor } from '../auth/sensitive-fields';
import type { Response } from 'express';
import {
  DEFAULT_IMPORT_POLICY,
  ImportPolicy,
  ImportPreview,
  ImportResult,
  ImportsService,
} from './imports.service';
import { MAX_IMPORT_BYTES, PRODUCT_CSV_TEMPLATE } from './product-csv';
import { isOldExcel, isXlsx, templateXlsx } from './product-sheet';
import { parse } from 'csv-parse/sync';
import { UserThrottle } from '../common/throttle/user-throttle.decorator';

/** Upsert policy chosen at import time (multipart fields arrive as strings) */
export class ImportPolicyDto {
  // Existing products (matched on SKU): update their details, or leave them alone
  @IsIn(['skip', 'update']) @IsOptional() onExisting?: 'skip' | 'update';
  // Overwrite prices/costs of existing products; off unless explicitly chosen
  @IsIn(['true', 'false']) @IsOptional() updatePrices?: 'true' | 'false';
}

export class ApplyImportDto extends ImportPolicyDto {
  @IsIn(['true', 'false']) @IsOptional() skipInvalid?: 'true' | 'false';
}

export class ExportProductsQueryDto {
  @IsIn(['csv', 'xlsx']) @IsOptional() format?: 'csv' | 'xlsx';
}

const toPolicy = (dto: ImportPolicyDto): ImportPolicy => ({
  onExisting: dto.onExisting ?? DEFAULT_IMPORT_POLICY.onExisting,
  updatePrices: dto.updatePrices === 'true',
});

const csvUpload = () =>
  FileInterceptor('file', {
    storage: memoryStorage(),
    limits: { fileSize: MAX_IMPORT_BYTES, files: 1, fields: 5 },
  });

const csvBody = {
  schema: {
    type: 'object',
    properties: {
      file: { type: 'string', format: 'binary' },
      skipInvalid: { type: 'string', enum: ['true', 'false'] },
      onExisting: { type: 'string', enum: ['skip', 'update'] },
      updatePrices: { type: 'string', enum: ['true', 'false'] },
    },
  },
};

function requireFile(file: Express.Multer.File | undefined): Buffer {
  if (!file?.buffer?.length) {
    throw new BadRequestException('Choose a CSV or Excel file to import');
  }
  // Excel workbooks (.xlsx) are read; the old .xls format is not
  if (isXlsx(file.buffer)) return file.buffer;
  if (isOldExcel(file.buffer)) {
    throw new BadRequestException(
      'This is an old Excel file (.xls). Save it as Excel Workbook (.xlsx) or CSV first.',
    );
  }
  // Other binary files (images, documents) are not CSV
  if (file.buffer.subarray(0, 8192).includes(0)) {
    throw new BadRequestException(
      'This is not a CSV file. Save the spreadsheet as CSV (UTF-8) first.',
    );
  }
  return file.buffer;
}

/** Current and new costs are left out for roles that can't see costs */
export function withoutHiddenCosts<T extends ImportPreview | ImportResult>(
  result: T,
  permissions: readonly string[] | undefined,
): T {
  if (!hiddenFieldsFor(permissions).has('cost')) return result;
  return {
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      priceChanges: row.priceChanges.filter((c) => c.field !== 'cost'),
    })),
  };
}

/** CSV product import: template, dry-run preview, apply */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('catalog.import')
@ApiTags('Products')
@ApiBearerAuth('JWT-auth')
@Controller('imports/products')
export class ImportsController {
  constructor(private imports: ImportsService) {}

  /**
   * GET /imports/products/template?format=csv|xlsx: the header and two example
   * rows, as CSV or as an Excel workbook
   */
  @Get('template')
  async template(
    @Query() query: ExportProductsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const excel = query.format === 'xlsx';
    res.set({
      'Content-Type': excel
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="products-import-template.${excel ? 'xlsx' : 'csv'}"`,
    });
    return new StreamableFile(
      excel
        ? await templateXlsx(parse(PRODUCT_CSV_TEMPLATE))
        : Buffer.from(PRODUCT_CSV_TEMPLATE, 'utf8'),
    );
  }

  /**
   * GET /imports/products/export?format=csv|xlsx: every product with the
   * template's columns; the cost column only for people who may see costs
   */
  @Get('export')
  @UserThrottle()
  async export(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @Query() query: ExportProductsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const includeCost = !hiddenFieldsFor(user.permissions).has('cost');
    const file = await this.imports.export(tenantId, query.format ?? 'csv', {
      includeCost,
    });
    res.set({
      'Content-Type': file.contentType,
      'Content-Disposition': `attachment; filename="${file.filename}"`,
    });
    return new StreamableFile(file.body);
  }

  /** POST /imports/products/preview (multipart file + policy): validate only, nothing is saved */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiBody(csvBody)
  @UseInterceptors(csvUpload())
  @UserThrottle()
  async preview(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: ImportPolicyDto,
  ): Promise<ImportPreview> {
    return withoutHiddenCosts(
      await this.imports.preview(tenantId, requireFile(file), toPolicy(dto)),
      user.permissions,
    );
  }

  /** POST /imports/products/apply (multipart file, skipInvalid, policy) */
  @Post('apply')
  @HttpCode(HttpStatus.OK)
  @ApiConsumes('multipart/form-data')
  @ApiBody(csvBody)
  @UseInterceptors(csvUpload())
  @UserThrottle()
  async apply(
    @CurrentTenant() tenantId: string,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: ApplyImportDto,
  ): Promise<ImportResult> {
    const result = await this.imports.apply(tenantId, requireFile(file), {
      skipInvalid: dto.skipInvalid === 'true',
      policy: toPolicy(dto),
      fileName: file?.originalname?.slice(0, 255),
    });
    return withoutHiddenCosts(result, user.permissions);
  }
}
