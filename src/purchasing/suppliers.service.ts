import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, FindOptionsOrder, In, Repository } from 'typeorm';
import { Supplier } from '../database/entities/supplier.entity';
import { SupplierProduct } from '../database/entities/supplier-product.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { TenantCrudService } from '../common/crud/tenant-crud.service';
import { AuditService } from '../audit/audit.service';
import { SaveSupplierProductsDto } from './purchasing.dto';
import { variantDisplayName } from './purchase-orders.service';

@Injectable()
export class SuppliersService extends TenantCrudService<Supplier> {
  protected readonly entityName = 'Supplier';
  protected readonly defaultOrder: FindOptionsOrder<Supplier> = { name: 'ASC' };

  constructor(
    @InjectRepository(Supplier) repository: Repository<Supplier>,
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {
    super(repository);
  }

  /**
   * What the supplier sells (their codes, last cost, minimum order quantity),
   * with the variant's SKU and name
   */
  async listProducts(tenantId: string, supplierId: string) {
    await this.findOne(tenantId, supplierId);
    const rows = await this.dataSource.getRepository(SupplierProduct).find({
      where: { tenantId, supplierId },
      relations: { variant: { product: true } },
    });
    return rows
      .map((row) => ({
        id: row.id,
        supplierId: row.supplierId,
        variantId: row.variantId,
        supplierSku: row.supplierSku,
        lastCost: row.lastCost,
        minOrderQty: row.minOrderQty,
        isPreferred: row.isPreferred,
        sku: row.variant?.sku ?? '',
        productName: row.variant
          ? variantDisplayName(row.variant.product?.name, row.variant.name)
          : '',
        variantCost: row.variant?.cost ?? null,
      }))
      .sort((a, b) => a.productName.localeCompare(b.productName));
  }

  /**
   * Replace the supplier's product list. Marking a variant preferred here
   * removes the flag from its other suppliers.
   */
  async saveProducts(
    tenantId: string,
    supplierId: string,
    dto: SaveSupplierProductsDto,
  ) {
    await this.findOne(tenantId, supplierId);
    const variantIds = dto.items.map((i) => i.variantId);
    if (new Set(variantIds).size !== variantIds.length) {
      throw new BadRequestException(
        'Each variant can only appear once per supplier',
      );
    }
    if (variantIds.length) {
      const found = await this.dataSource
        .getRepository(ProductVariant)
        .count({ where: { tenantId, id: In(variantIds) } });
      if (found !== variantIds.length) {
        throw new NotFoundException('One or more variants were not found');
      }
    }
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(SupplierProduct);
      const before = await repo.find({ where: { tenantId, supplierId } });
      const byVariant = new Map(before.map((row) => [row.variantId, row]));
      const removed = before.filter(
        (row) => !variantIds.includes(row.variantId),
      );
      if (removed.length) {
        await repo.delete({ tenantId, id: In(removed.map((r) => r.id)) });
      }
      const preferred = dto.items
        .filter((i) => i.isPreferred)
        .map((i) => i.variantId);
      if (preferred.length) {
        await manager
          .createQueryBuilder()
          .update(SupplierProduct)
          .set({ isPreferred: false })
          .where(
            '"tenantId" = :tenantId AND "variantId" IN (:...preferred) AND "supplierId" <> :supplierId',
            { tenantId, preferred, supplierId },
          )
          .execute();
      }
      for (const item of dto.items) {
        const row =
          byVariant.get(item.variantId) ??
          repo.create({ tenantId, supplierId, variantId: item.variantId });
        row.supplierSku = item.supplierSku?.trim() || null;
        row.lastCost = item.lastCost ?? null;
        row.minOrderQty = item.minOrderQty ?? null;
        row.isPreferred = !!item.isPreferred;
        await repo.save(row);
      }
      await this.auditService.record(
        {
          tenantId,
          action: 'supplier.products_updated',
          entityType: 'supplier',
          entityId: supplierId,
          changes: {
            before: before.map((r) => ({
              variantId: r.variantId,
              supplierSku: r.supplierSku,
              lastCost: r.lastCost,
              minOrderQty: r.minOrderQty,
              isPreferred: r.isPreferred,
            })),
            after: dto.items,
          },
        },
        manager,
      );
    });
    return this.listProducts(tenantId, supplierId);
  }
}
