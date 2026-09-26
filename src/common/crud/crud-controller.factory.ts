import {
  Body,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  PipeTransform,
  Post,
  Type,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { DeepPartial } from 'typeorm';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { CurrentTenant } from '../../auth/decorators/current-tenant.decorator';
import {
  AnyMember,
  RequireAnyPermission,
  RequirePermissions,
} from '../../auth/decorators/permissions.decorator';
import type { Permission } from '../../auth/permissions';
import { AuditService } from '../../audit/audit.service';
// Audit rows can't be erased: no personal data in them
import { crudAuditChanges } from '../../customers/audit-safe';
import {
  parseExpectedVersion,
  TenantCrudService,
  withExpectedVersion,
} from './tenant-crud.service';

const bodyPipe = (expectedType: Type) =>
  new ValidationPipe({
    expectedType,
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  });

// `expectedVersion` is read separately (optimistic concurrency), not by the update DTO
const stripExpectedVersion: PipeTransform = {
  transform(value: unknown) {
    if (value && typeof value === 'object' && 'expectedVersion' in value) {
      const rest = { ...(value as Record<string, unknown>) };
      delete rest.expectedVersion;
      return rest;
    }
    return value;
  },
};

/**
 * Who may list / get the resource: one permission, any of several
 * ({ anyOf: [...] }), or 'anyMember' for reference data every signed-in user needs
 */
export type CrudReadAccess = Permission | { anyOf: Permission[] } | 'anyMember';

export interface CrudControllerOptions {
  // Audit entity type, e.g. 'tax_rate'
  entityType: string;
  // Permission for all writes, or per operation
  permission:
    Permission | { create: Permission; update: Permission; remove: Permission };
  // Required: reads are not open to every member by default
  read: CrudReadAccess;
}

/** The decorator that grants read access (also for subclasses overriding findAll/findOne) */
export function crudReadAccess(read: CrudReadAccess): MethodDecorator {
  if (read === 'anyMember') return AnyMember();
  if (typeof read === 'object') return RequireAnyPermission(...read.anyOf);
  return RequirePermissions(read);
}

/**
 * Builds a controller base class with tenant-scoped CRUD routes.
 * Reads need `read`; writes need the given permission and are audited.
 * Subclass it and add @Controller('path'). A subclass overriding a read route must
 * declare its access again (decorators aren't inherited by the override).
 */
export function CrudController<T extends { id: string; tenantId: string }>(
  createDto: Type,
  updateDto: Type,
  options: CrudControllerOptions,
) {
  const perms =
    typeof options.permission === 'string'
      ? {
          create: options.permission,
          update: options.permission,
          remove: options.permission,
        }
      : options.permission;
  const { entityType } = options;
  const canRead = crudReadAccess(options.read);

  @UseGuards(JwtAuthGuard, PermissionsGuard)
  abstract class BaseCrudController {
    @Inject(AuditService) readonly auditService: AuditService;

    constructor(readonly service: TenantCrudService<T>) {}

    @Get()
    @canRead
    findAll(@CurrentTenant() tenantId: string): Promise<T[]> {
      return this.service.findAll(tenantId);
    }

    @Get(':id')
    @canRead
    findOne(
      @CurrentTenant() tenantId: string,
      @Param('id', ParseUUIDPipe) id: string,
    ): Promise<T> {
      return this.service.findOne(tenantId, id);
    }

    @Post()
    @RequirePermissions(perms.create)
    async create(
      @CurrentTenant() tenantId: string,
      @Body(bodyPipe(createDto)) dto: object,
    ): Promise<T> {
      const created = await this.service.create(
        tenantId,
        dto as DeepPartial<T>,
      );
      await this.auditService.record({
        tenantId,
        action: `${entityType}.created`,
        entityType,
        entityId: created.id,
        changes: crudAuditChanges(entityType, 'created', undefined, created),
      });
      return created;
    }

    /**
     * Optimistic concurrency: send the version you edited as `If-Match: <version>`
     * (or `expectedVersion` in the body). If someone saved the record since, the
     * update is refused with 409 VERSION_CONFLICT and the current version.
     * Without either, the update applies as before (last write wins).
     */
    @Patch(':id')
    @RequirePermissions(perms.update)
    async update(
      @CurrentTenant() tenantId: string,
      @Param('id', ParseUUIDPipe) id: string,
      @Body(stripExpectedVersion, bodyPipe(updateDto)) dto: object,
      @Body('expectedVersion') bodyVersion?: unknown,
      @Headers('if-match') ifMatch?: string,
    ): Promise<T> {
      const expectedVersion =
        parseExpectedVersion(ifMatch) ?? parseExpectedVersion(bodyVersion);
      const before = { ...(await this.service.findOne(tenantId, id)) };
      const updated = await withExpectedVersion(id, expectedVersion, () =>
        this.service.update(tenantId, id, dto as DeepPartial<T>),
      );
      await this.auditService.record({
        tenantId,
        action: `${entityType}.updated`,
        entityType,
        entityId: id,
        changes: crudAuditChanges(entityType, 'updated', before, updated),
      });
      return updated;
    }

    @Delete(':id')
    @RequirePermissions(perms.remove)
    @HttpCode(HttpStatus.NO_CONTENT)
    async remove(
      @CurrentTenant() tenantId: string,
      @Param('id', ParseUUIDPipe) id: string,
    ): Promise<void> {
      const before = await this.service.findOne(tenantId, id);
      await this.service.remove(tenantId, id);
      await this.auditService.record({
        tenantId,
        action: `${entityType}.deleted`,
        entityType,
        entityId: id,
        changes: crudAuditChanges(entityType, 'deleted', before),
      });
    }
  }

  return BaseCrudController;
}
