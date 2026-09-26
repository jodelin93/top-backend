import { AsyncLocalStorage } from 'async_hooks';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  DeepPartial,
  FindOptionsOrder,
  FindOptionsWhere,
  Repository,
} from 'typeorm';
import {
  isPgError,
  PG_FOREIGN_KEY_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from '../utils/pg-error';

interface TenantEntity {
  id: string;
  tenantId: string;
}

/**
 * Optimistic concurrency (spec §24): the version the client last saw, for one
 * record, while an update runs. Set by the CRUD controller from `If-Match` or
 * the body's `expectedVersion`; subclasses overriding update() need no change.
 */
const expectedVersions = new AsyncLocalStorage<{
  id: string;
  version: number;
}>();

export function withExpectedVersion<R>(
  id: string,
  version: number | null | undefined,
  fn: () => Promise<R>,
): Promise<R> {
  if (version === null || version === undefined) return fn();
  return expectedVersions.run({ id, version }, fn);
}

/** 409 telling the client to reload: someone else saved the record first */
export function versionConflict(
  entityName: string,
  currentVersion: number,
  expectedVersion: number,
): ConflictException {
  return new ConflictException({
    message:
      'This record was changed by someone else. Reload it and try again.',
    error: 'Conflict',
    code: 'VERSION_CONFLICT',
    retryable: false,
    entity: entityName,
    currentVersion,
    expectedVersion,
  });
}

/**
 * Parse an `If-Match` header or `expectedVersion` value: 3, "3", W/"3".
 * Anything else (absent, "*") means no check.
 */
export function parseExpectedVersion(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const match = /^\s*(?:W\/)?"?(\d{1,10})"?\s*$/.exec(value);
  return match ? Number(match[1]) : undefined;
}

/**
 * Basic tenant-scoped CRUD shared by simple resources (branches, tax rates, ...).
 * Every query is filtered by tenantId so tenants can never see each other's rows.
 */
export abstract class TenantCrudService<T extends TenantEntity> {
  protected abstract readonly entityName: string;
  protected readonly defaultOrder?: FindOptionsOrder<T>;

  constructor(protected readonly repository: Repository<T>) {}

  findAll(tenantId: string, where: FindOptionsWhere<T> = {}): Promise<T[]> {
    return this.repository.find({
      where: { ...where, tenantId } as FindOptionsWhere<T>,
      order: this.defaultOrder,
    });
  }

  async findOne(tenantId: string, id: string): Promise<T> {
    const entity = await this.repository.findOne({
      where: { id, tenantId } as FindOptionsWhere<T>,
    });
    if (!entity) {
      throw new NotFoundException(`${this.entityName} not found`);
    }
    return entity;
  }

  async create(tenantId: string, data: DeepPartial<T>): Promise<T> {
    const entity = this.repository.create({
      ...data,
      tenantId,
    } as DeepPartial<T>);
    return this.saveOrConflict(entity);
  }

  async update(tenantId: string, id: string, data: DeepPartial<T>): Promise<T> {
    const entity = await this.findOne(tenantId, id);
    this.assertVersion(entity);
    Object.assign(entity, data);
    return this.saveOrConflict(entity);
  }

  /** Column holding the entity's @VersionColumn, if it has one */
  protected get versionProperty(): string | undefined {
    return this.repository.metadata?.versionColumn?.propertyName;
  }

  /** The version the client expects for this entity, if it sent one */
  protected expectedVersionFor(entity: T): number | undefined {
    const expected = expectedVersions.getStore();
    return expected && expected.id === entity.id && this.versionProperty
      ? expected.version
      : undefined;
  }

  /** 409 when the loaded entity is not at the version the client expects */
  protected assertVersion(entity: T): void {
    const expected = this.expectedVersionFor(entity);
    const property = this.versionProperty;
    if (expected === undefined || !property) return;
    const current = Number((entity as Record<string, unknown>)[property]);
    if (current !== expected) {
      throw versionConflict(this.entityName, current, expected);
    }
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const entity = await this.findOne(tenantId, id);
    try {
      await this.repository.remove(entity);
    } catch (error) {
      if (isPgError(error, PG_FOREIGN_KEY_VIOLATION)) {
        throw new ConflictException(
          `${this.entityName} is in use and cannot be deleted. Deactivate it instead.`,
        );
      }
      throw error;
    }
  }

  // Turn unique-constraint violations (duplicate codes) into 409s
  protected async saveOrConflict(entity: T): Promise<T> {
    try {
      const expected = entity.id ? this.expectedVersionFor(entity) : undefined;
      if (expected === undefined) return await this.repository.save(entity);
      // Checked again under the row lock, so two editors can't both win
      return await this.repository.manager.transaction(async (manager) => {
        const property = this.versionProperty as string;
        const locked = await manager
          .getRepository<T>(this.repository.target)
          .createQueryBuilder('row')
          .select(`row.${property}`, 'version')
          .where('row.id = :id', { id: entity.id })
          .setLock('pessimistic_write')
          .getRawOne<{ version: number }>();
        const current = Number(locked?.version);
        if (locked && current !== expected) {
          throw versionConflict(this.entityName, current, expected);
        }
        return manager.getRepository<T>(this.repository.target).save(entity);
      });
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException(
          `A ${this.entityName.toLowerCase()} with this code already exists`,
        );
      }
      throw error;
    }
  }
}
