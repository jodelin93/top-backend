import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  DeepPartial,
  EntityManager,
  FindOptionsWhere,
  In,
  Repository,
} from 'typeorm';
import {
  accessibleLocationIds,
  assertAllBranches,
  branchScope,
  branchWarehouseIdsSql,
  branchWhere,
  canAccessBranch,
} from '../auth/branch-scope';
import { BranchWarehouse } from '../database/entities/branch-warehouse.entity';
import { TenantCrudService } from '../common/crud/tenant-crud.service';
import { Branch } from '../database/entities/branch.entity';
import { Register } from '../database/entities/register.entity';
import { Warehouse } from '../database/entities/warehouse.entity';
import {
  InventoryLocation,
  LocationStockStatus,
} from '../database/entities/inventory-location.entity';
import { locationStatusFields } from '../inventory/stock-rules';
import { PaymentMethod } from '../database/entities/payment-method.entity';
import { TaxRate, TaxRateType } from '../database/entities/tax-rate.entity';

@Injectable()
export class BranchesService extends TenantCrudService<Branch> {
  protected readonly entityName = 'Branch';
  protected readonly defaultOrder = { code: 'ASC' as const };
  constructor(@InjectRepository(Branch) repository: Repository<Branch>) {
    super(repository);
  }

  // A branch-limited user only sees (and edits) their branches (spec §9)
  findAll(tenantId: string, where: FindOptionsWhere<Branch> = {}) {
    return super.findAll(tenantId, {
      ...where,
      ...branchWhere(undefined, 'id'),
    });
  }

  async findOne(tenantId: string, id: string) {
    const branch = await super.findOne(tenantId, id);
    if (!canAccessBranch(branch.id)) {
      throw new NotFoundException('Branch not found');
    }
    return branch;
  }

  // A new branch would be outside a branch-limited user's own access
  async create(tenantId: string, data: DeepPartial<Branch>) {
    assertAllBranches(
      null,
      'Only users with access to every branch can add one',
    );
    return super.create(tenantId, data);
  }

  async remove(tenantId: string, id: string) {
    assertAllBranches(
      null,
      'Only users with access to every branch can delete one',
    );
    return super.remove(tenantId, id);
  }
}

/** Warehouse ids a branch-limited user may see (null = all) */
async function accessibleWarehouseIds(
  manager: EntityManager,
  tenantId: string,
): Promise<string[] | null> {
  const scope = branchScope();
  if (scope === null) return null;
  if (!scope.length) return [];
  const rows = await manager.query<{ warehouseId: string }[]>(
    `SELECT DISTINCT "warehouseId" FROM ${branchWarehouseIdsSql('$2', '$1')} x`,
    [tenantId, [...scope]],
  );
  return rows.map((r) => r.warehouseId);
}

@Injectable()
export class WarehousesService extends TenantCrudService<Warehouse> {
  protected readonly entityName = 'Warehouse';
  protected readonly defaultOrder = { code: 'ASC' as const };
  constructor(@InjectRepository(Warehouse) repository: Repository<Warehouse>) {
    super(repository);
  }

  // Branch-limited users see the warehouses their branches work from
  async findAll(tenantId: string, where: FindOptionsWhere<Warehouse> = {}) {
    const ids = await accessibleWarehouseIds(this.repository.manager, tenantId);
    return super.findAll(tenantId, ids ? { ...where, id: In(ids) } : where);
  }

  async findOne(tenantId: string, id: string) {
    const warehouse = await super.findOne(tenantId, id);
    const ids = await accessibleWarehouseIds(this.repository.manager, tenantId);
    if (ids && !ids.includes(warehouse.id)) {
      throw new NotFoundException('Warehouse not found');
    }
    return warehouse;
  }

  // Unassigned, it would be invisible to its branch-limited creator
  async create(tenantId: string, data: DeepPartial<Warehouse>) {
    assertAllBranches(
      null,
      'Only users with access to every branch can add a warehouse',
    );
    return super.create(tenantId, data);
  }

  async remove(tenantId: string, id: string) {
    assertAllBranches(
      null,
      'Only users with access to every branch can delete a warehouse',
    );
    return super.remove(tenantId, id);
  }
}

/**
 * Which warehouses serve which branches (branch_warehouses). Read by anyone
 * managing settings (limited to their branches); changed only by users with
 * every branch, since it widens what branch-limited users see.
 */
@Injectable()
export class BranchWarehousesService {
  constructor(
    @InjectRepository(BranchWarehouse)
    private repository: Repository<BranchWarehouse>,
    private branchesService: BranchesService,
    private warehousesService: WarehousesService,
  ) {}

  async findAll(tenantId: string) {
    const rows = await this.repository.find({
      where: { tenantId, ...branchWhere() },
      order: { createdAt: 'ASC' },
    });
    return rows.map((r) => ({
      branchId: r.branchId,
      warehouseId: r.warehouseId,
    }));
  }

  /** Replace the warehouses of a branch */
  async set(tenantId: string, branchId: string, warehouseIds: string[]) {
    assertAllBranches(
      null,
      'Only users with access to every branch can assign warehouses',
    );
    await this.branchesService.findOne(tenantId, branchId);
    const unique = [...new Set(warehouseIds)];
    for (const id of unique) {
      await this.warehousesService.findOne(tenantId, id);
    }
    const before = await this.repository.find({
      where: { tenantId, branchId },
    });
    await this.repository.manager.transaction(async (manager) => {
      await manager.delete(BranchWarehouse, { tenantId, branchId });
      if (unique.length) {
        await manager.insert(
          BranchWarehouse,
          unique.map((warehouseId) => ({ tenantId, branchId, warehouseId })),
        );
      }
    });
    return {
      branchId,
      warehouseIds: unique,
      before: before.map((r) => r.warehouseId),
    };
  }
}

@Injectable()
export class LocationsService extends TenantCrudService<InventoryLocation> {
  protected readonly entityName = 'Location';
  protected readonly defaultOrder = { code: 'ASC' as const };
  constructor(
    @InjectRepository(InventoryLocation)
    repository: Repository<InventoryLocation>,
    private warehousesService: WarehousesService,
  ) {
    super(repository);
  }

  // Branch-limited users see the locations of their branches' warehouses
  async findAll(
    tenantId: string,
    where: FindOptionsWhere<InventoryLocation> = {},
  ) {
    const ids = await accessibleLocationIds(this.repository.manager, tenantId);
    return super.findAll(tenantId, ids ? { ...where, id: In(ids) } : where);
  }

  async findOne(tenantId: string, id: string) {
    const location = await super.findOne(tenantId, id);
    const ids = await accessibleLocationIds(this.repository.manager, tenantId);
    if (ids && !ids.includes(location.id)) {
      throw new NotFoundException('Location not found');
    }
    return location;
  }

  async create(tenantId: string, data: DeepPartial<InventoryLocation>) {
    await this.warehousesService.findOne(tenantId, data.warehouseId as string);
    return super.create(tenantId, {
      ...data,
      ...locationStatusFields({
        stockStatus: data.stockStatus,
        isSellable: data.isSellable,
      }),
    });
  }

  async update(
    tenantId: string,
    id: string,
    data: DeepPartial<InventoryLocation>,
  ) {
    const current = await this.findOne(tenantId, id);
    if (current.stockStatus === LocationStockStatus.TRANSIT) {
      throw new BadRequestException(
        'The transit location is managed by the system',
      );
    }
    if (data.warehouseId) {
      await this.warehousesService.findOne(tenantId, data.warehouseId);
    }
    return super.update(tenantId, id, {
      ...data,
      ...locationStatusFields({
        stockStatus: data.stockStatus,
        isSellable: data.isSellable,
      }),
    });
  }
}

@Injectable()
export class RegistersService extends TenantCrudService<Register> {
  protected readonly entityName = 'Register';
  protected readonly defaultOrder = { code: 'ASC' as const };
  constructor(
    @InjectRepository(Register) repository: Repository<Register>,
    private branchesService: BranchesService,
    private locationsService: LocationsService,
  ) {
    super(repository);
  }

  // A branch-limited user only sees the tills of their branches (spec §9)
  findAll(tenantId: string, where: FindOptionsWhere<Register> = {}) {
    return super.findAll(tenantId, { ...where, ...branchWhere() });
  }

  async findOne(tenantId: string, id: string) {
    const register = await super.findOne(tenantId, id);
    if (!canAccessBranch(register.branchId)) {
      throw new NotFoundException('Register not found');
    }
    return register;
  }

  private async validateRefs(tenantId: string, data: DeepPartial<Register>) {
    if (data.branchId) {
      await this.branchesService.findOne(tenantId, data.branchId);
    }
    if (data.defaultLocationId) {
      await this.locationsService.findOne(tenantId, data.defaultLocationId);
    }
  }

  async create(tenantId: string, data: DeepPartial<Register>) {
    await this.validateRefs(tenantId, data);
    const register = await super.create(tenantId, data);
    await this.assignSellingWarehouse(register);
    return register;
  }

  async update(tenantId: string, id: string, data: DeepPartial<Register>) {
    await this.validateRefs(tenantId, data);
    const register = await super.update(tenantId, id, data);
    await this.assignSellingWarehouse(register);
    return register;
  }

  /** The warehouse a till sells from serves its branch (branch_warehouses) */
  private async assignSellingWarehouse(register: Register) {
    if (!register.defaultLocationId || !register.branchId) return;
    await this.repository.manager.query(
      `INSERT INTO branch_warehouses ("tenantId", "branchId", "warehouseId")
       SELECT l."tenantId", $2, l."warehouseId" FROM inventory_locations l
        WHERE l.id = $3 AND l."tenantId" = $1
       ON CONFLICT ("branchId", "warehouseId") DO NOTHING`,
      [register.tenantId, register.branchId, register.defaultLocationId],
    );
  }
}

@Injectable()
export class PaymentMethodsService extends TenantCrudService<PaymentMethod> {
  protected readonly entityName = 'Payment method';
  protected readonly defaultOrder = { code: 'ASC' as const };
  constructor(
    @InjectRepository(PaymentMethod) repository: Repository<PaymentMethod>,
  ) {
    super(repository);
  }
}

@Injectable()
export class TaxRatesService extends TenantCrudService<TaxRate> {
  protected readonly entityName = 'Tax rate';
  protected readonly defaultOrder = { code: 'ASC' as const };
  constructor(@InjectRepository(TaxRate) repository: Repository<TaxRate>) {
    super(repository);
  }

  async create(tenantId: string, data: DeepPartial<TaxRate>) {
    this.assertPercentage(data);
    // Validated DTOs carry undefined keys, so a spread default would be overwritten
    return super.create(tenantId, {
      ...data,
      isDefault: data.isDefault ?? false,
    });
  }

  async update(tenantId: string, id: string, data: DeepPartial<TaxRate>) {
    this.assertPercentage(data);
    return super.update(tenantId, id, data);
  }

  // Sales tax math only supports percentage rates for now
  private assertPercentage(data: DeepPartial<TaxRate>) {
    if (data.taxType && data.taxType !== TaxRateType.PERCENTAGE) {
      throw new BadRequestException('Only percentage tax rates are supported');
    }
  }
}
