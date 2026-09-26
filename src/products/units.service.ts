import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ProductUnit } from '../database/entities/product-unit.entity';
import { Product } from '../database/entities/product.entity';
import { AuditService } from '../audit/audit.service';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { normalizeUnitCode, unitPrecision } from './catalog-rules';
import { CreateUnitDto, UpdateUnitDto } from './dto/units.dto';

/**
 * Units of measure (piece, kg, litre…). Products store a default unit; units
 * that allow decimals make an item measured: sold, stocked and counted in
 * decimal quantities up to the unit's precision (1.250 kg).
 */
@Injectable()
export class UnitsService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {}

  private get repo() {
    return this.dataSource.getRepository(ProductUnit);
  }

  list(tenantId: string) {
    return this.repo.find({ where: { tenantId }, order: { code: 'ASC' } });
  }

  async findOne(tenantId: string, id: string) {
    const unit = await this.repo.findOne({ where: { tenantId, id } });
    if (!unit) throw new NotFoundException('Unit not found');
    return unit;
  }

  async create(tenantId: string, dto: CreateUnitDto) {
    const code = normalizeUnitCode(dto.code);
    if (!code) throw new BadRequestException('Enter a unit code');
    const allowsDecimals = dto.allowsDecimals ?? false;
    const unit = await this.save(
      this.repo.create({
        tenantId,
        code,
        name: dto.name.trim(),
        allowsDecimals,
        precision: unitPrecision(allowsDecimals, dto.precision),
      }),
    );
    await this.auditService.record({
      tenantId,
      action: 'unit.created',
      entityType: 'unit',
      entityId: unit.id,
      changes: { after: unit },
    });
    return unit;
  }

  async update(tenantId: string, id: string, dto: UpdateUnitDto) {
    const unit = await this.findOne(tenantId, id);
    const before = { ...unit };
    if (dto.code !== undefined) unit.code = normalizeUnitCode(dto.code);
    if (dto.name !== undefined) unit.name = dto.name.trim();
    if (dto.isActive !== undefined) unit.isActive = dto.isActive;
    if (dto.allowsDecimals === false && unit.allowsDecimals) {
      await this.assertNoDecimalStock(tenantId, id);
    }
    if (dto.allowsDecimals !== undefined)
      unit.allowsDecimals = dto.allowsDecimals;
    unit.precision = unitPrecision(
      unit.allowsDecimals,
      dto.precision ?? unit.precision,
    );
    const saved = await this.save(unit);
    await this.auditService.record({
      tenantId,
      action: 'unit.updated',
      entityType: 'unit',
      entityId: id,
      changes: { before, after: saved },
    });
    return saved;
  }

  /** Only a unit no product uses can be deleted (deactivate it otherwise) */
  async remove(tenantId: string, id: string) {
    await this.findOne(tenantId, id);
    const used = await this.dataSource
      .getRepository(Product)
      .count({ where: { tenantId, unitId: id } });
    if (used > 0) {
      throw new ConflictException(
        `${used} product(s) use this unit: deactivate it instead`,
      );
    }
    await this.repo.delete({ tenantId, id });
    await this.auditService.record({
      tenantId,
      action: 'unit.deleted',
      entityType: 'unit',
      entityId: id,
    });
  }

  /**
   * A unit can only stop allowing decimals while none of its products holds a
   * decimal quantity in stock (it could never be sold or counted again).
   */
  private async assertNoDecimalStock(tenantId: string, unitId: string) {
    const [row] = await this.dataSource.query<{ sku: string }[]>(
      `SELECT v.sku FROM stock_levels l
         JOIN product_variants v ON v.id = l."variantId"
         JOIN products p ON p.id = v."productId"
        WHERE l."tenantId" = $1 AND p."unitId" = $2
          AND (l."quantityOnHand" <> TRUNC(l."quantityOnHand")
            OR l."quantityReserved" <> TRUNC(l."quantityReserved"))
        LIMIT 1`,
      [tenantId, unitId],
    );
    if (row) {
      throw new ConflictException(
        `${row.sku} has a decimal quantity in stock: count it to whole units before turning decimals off`,
      );
    }
  }

  private async save(unit: ProductUnit) {
    try {
      return await this.repo.save(unit);
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException(`Unit code ${unit.code} already exists`);
      }
      throw error;
    }
  }
}
