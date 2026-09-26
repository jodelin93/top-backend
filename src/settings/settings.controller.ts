import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { MAX_LOGO_BYTES } from './settings.service';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  Delete,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { AuditService } from '../audit/audit.service';
import {
  AnyMember,
  RequirePermissions,
} from '../auth/decorators/permissions.decorator';
import { CrudController } from '../common/crud/crud-controller.factory';
import { Idempotent } from '../common/idempotency/idempotent.decorator';
import { SettingsService } from './settings.service';
import {
  BranchesService,
  BranchWarehousesService,
  LocationsService,
  PaymentMethodsService,
  RegistersService,
  TaxRatesService,
  WarehousesService,
} from './settings-resources.service';
import {
  CreateBranchDto,
  CreateLocationDto,
  CreatePaymentMethodDto,
  CreateRegisterDto,
  CreateTaxRateDto,
  CreateWarehouseDto,
  SetBranchWarehousesDto,
  UpdateBranchDto,
  UpdateLocationDto,
  UpdatePaymentMethodDto,
  UpdateRegisterDto,
  UpdateStoreSettingsDto,
  UpdateTaxRateDto,
  UpdateWarehouseDto,
} from './dto/settings.dto';
import { Branch } from '../database/entities/branch.entity';
import { Register } from '../database/entities/register.entity';
import { Warehouse } from '../database/entities/warehouse.entity';
import { InventoryLocation } from '../database/entities/inventory-location.entity';
import { PaymentMethod } from '../database/entities/payment-method.entity';
import { TaxRate } from '../database/entities/tax-rate.entity';

@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Settings')
@ApiBearerAuth('JWT-auth')
@Controller('settings')
export class SettingsController {
  constructor(private settingsService: SettingsService) {}

  @Get()
  @AnyMember() // the till and every screen read the store settings
  getSettings(@CurrentTenant() tenantId: string) {
    return this.settingsService.getSettings(tenantId);
  }

  /**
   * Upload the business logo shown on receipts and invoices (JPEG, PNG or WebP, max 2 MB)
   * POST /settings/logo (multipart: file)
   */
  @Post('logo')
  @RequirePermissions('settings.manage')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: MAX_LOGO_BYTES, files: 1, fields: 0 },
    }),
  )
  uploadLogo(
    @CurrentTenant() tenantId: string,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    return this.settingsService.uploadLogo(tenantId, file);
  }

  /**
   * Remove the business logo
   * DELETE /settings/logo
   */
  @Delete('logo')
  @RequirePermissions('settings.manage')
  removeLogo(@CurrentTenant() tenantId: string) {
    return this.settingsService.updateSettings(tenantId, {
      businessLogoUrl: '',
    });
  }

  @Patch()
  @RequirePermissions('settings.manage')
  @Idempotent('settings.update')
  updateSettings(
    @CurrentTenant() tenantId: string,
    @Body() dto: UpdateStoreSettingsDto,
  ) {
    return this.settingsService.updateSettings(tenantId, dto);
  }

  /**
   * Settings history (applied, scheduled and cancelled versions), newest first
   */
  @Get('versions')
  @RequirePermissions('settings.manage')
  listVersions(
    @CurrentTenant() tenantId: string,
    @Query('limit') limit?: string,
  ) {
    return this.settingsService.listVersions(
      tenantId,
      limit ? parseInt(limit, 10) || 50 : 50,
    );
  }

  /** One version with its full settings snapshot */
  @Get('versions/:id')
  @RequirePermissions('settings.manage')
  getVersion(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.settingsService.getVersion(tenantId, id);
  }

  /** Cancel a scheduled change before it takes effect */
  @Post('versions/:id/cancel')
  @RequirePermissions('settings.manage')
  @HttpCode(HttpStatus.OK)
  cancelVersion(
    @CurrentTenant() tenantId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.settingsService.cancelVersion(tenantId, id);
  }

  /**
   * Create a default branch, stockroom, register and payment methods
   */
  @Post('initialize')
  @RequirePermissions('settings.manage')
  initialize(@CurrentTenant() tenantId: string) {
    return this.settingsService.initializeDefaults(tenantId);
  }
}

@ApiTags('Settings')
@ApiBearerAuth('JWT-auth')
@Controller('branches')
export class BranchesController extends CrudController<Branch>(
  CreateBranchDto,
  UpdateBranchDto,
  {
    entityType: 'branch',
    permission: 'settings.manage',
    // Reference data the till and most screens need
    read: 'anyMember',
  },
) {
  constructor(service: BranchesService) {
    super(service);
  }
}

@ApiTags('Settings')
@ApiBearerAuth('JWT-auth')
@Controller('registers')
export class RegistersController extends CrudController<Register>(
  CreateRegisterDto,
  UpdateRegisterDto,
  {
    entityType: 'register',
    permission: 'settings.manage',
    // Reference data the till and most screens need
    read: 'anyMember',
  },
) {
  constructor(service: RegistersService) {
    super(service);
  }
}

@ApiTags('Settings')
@ApiBearerAuth('JWT-auth')
@Controller('warehouses')
export class WarehousesController extends CrudController<Warehouse>(
  CreateWarehouseDto,
  UpdateWarehouseDto,
  {
    entityType: 'warehouse',
    permission: 'settings.manage',
    // Reference data the till and most screens need
    read: 'anyMember',
  },
) {
  constructor(service: WarehousesService) {
    super(service);
  }
}

/**
 * Which warehouses serve which branches: branch-limited users see the stock of
 * their branches' warehouses only (spec §9)
 */
@UseGuards(JwtAuthGuard, PermissionsGuard)
@ApiTags('Settings')
@ApiBearerAuth('JWT-auth')
@Controller('branch-warehouses')
export class BranchWarehousesController {
  constructor(
    private service: BranchWarehousesService,
    private auditService: AuditService,
  ) {}

  /** GET /branch-warehouses: [{ branchId, warehouseId }] */
  @Get()
  @RequirePermissions('settings.manage')
  findAll(@CurrentTenant() tenantId: string) {
    return this.service.findAll(tenantId);
  }

  /** PUT /branch-warehouses/:branchId { warehouseIds } (needs every branch) */
  @Put(':branchId')
  @RequirePermissions('settings.manage')
  async set(
    @CurrentTenant() tenantId: string,
    @Param('branchId', ParseUUIDPipe) branchId: string,
    @Body() dto: SetBranchWarehousesDto,
  ) {
    const { before, ...result } = await this.service.set(
      tenantId,
      branchId,
      dto.warehouseIds,
    );
    await this.auditService.record({
      tenantId,
      action: 'branch.warehouses_changed',
      entityType: 'branch',
      entityId: branchId,
      changes: {
        before: { warehouseIds: before },
        after: { warehouseIds: result.warehouseIds },
      },
    });
    return result;
  }
}

@ApiTags('Settings')
@ApiBearerAuth('JWT-auth')
@Controller('locations')
export class LocationsController extends CrudController<InventoryLocation>(
  CreateLocationDto,
  UpdateLocationDto,
  {
    entityType: 'location',
    permission: 'settings.manage',
    // Reference data the till and most screens need
    read: 'anyMember',
  },
) {
  constructor(service: LocationsService) {
    super(service);
  }
}

@ApiTags('Settings')
@ApiBearerAuth('JWT-auth')
@Controller('payment-methods')
export class PaymentMethodsController extends CrudController<PaymentMethod>(
  CreatePaymentMethodDto,
  UpdatePaymentMethodDto,
  {
    entityType: 'payment_method',
    permission: 'settings.manage',
    // Reference data the till and most screens need
    read: 'anyMember',
  },
) {
  constructor(service: PaymentMethodsService) {
    super(service);
  }
}

@ApiTags('Settings')
@ApiBearerAuth('JWT-auth')
@Controller('tax-rates')
export class TaxRatesController extends CrudController<TaxRate>(
  CreateTaxRateDto,
  UpdateTaxRateDto,
  {
    entityType: 'tax_rate',
    permission: 'settings.manage',
    // Reference data the till and most screens need
    read: 'anyMember',
  },
) {
  constructor(service: TaxRatesService) {
    super(service);
  }
}
