import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, Not } from 'typeorm';
import { ProductBarcode } from '../database/entities/product-barcode.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { AuditService } from '../audit/audit.service';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { normalizeBarcode } from './catalog-rules';

export const MAX_BARCODES_PER_VARIANT = 20;

// Trim, no inner spaces, upper-case unless numeric (leading zeros kept): see catalog-rules
export { normalizeBarcode };

/**
 * Extra barcodes per variant (product_barcodes). The variant's own `barcode`
 * column stays the primary one and is mirrored here as the isPrimary row, so
 * a barcode can belong to only one variant per store.
 */
@Injectable()
export class ProductBarcodesService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {}

  async list(
    tenantId: string,
    productId: string,
    variantId: string,
  ): Promise<ProductBarcode[]> {
    await this.findVariant(
      this.dataSource.manager,
      tenantId,
      productId,
      variantId,
    );
    return this.dataSource.getRepository(ProductBarcode).find({
      where: { tenantId, variantId },
      order: { isPrimary: 'DESC', createdAt: 'ASC' },
    });
  }

  async add(
    tenantId: string,
    productId: string,
    variantId: string,
    rawBarcode: string,
  ): Promise<ProductBarcode> {
    const barcode = normalizeBarcode(rawBarcode);
    if (!barcode) {
      throw new BadRequestException('Enter a barcode');
    }
    return this.dataSource.transaction(async (manager) => {
      await this.findVariant(manager, tenantId, productId, variantId);
      const repo = manager.getRepository(ProductBarcode);
      const own = await repo.findOne({
        where: { tenantId, variantId, barcode },
      });
      if (own) {
        throw new ConflictException(
          `This variant already has barcode ${barcode}`,
        );
      }
      const count = await repo.count({ where: { tenantId, variantId } });
      if (count >= MAX_BARCODES_PER_VARIANT) {
        throw new BadRequestException(
          `A variant can have at most ${MAX_BARCODES_PER_VARIANT} barcodes`,
        );
      }
      await this.assertBarcodeFree(manager, tenantId, barcode, variantId);
      const saved = await this.saveOrConflict(
        manager,
        repo.create({ tenantId, variantId, barcode, isPrimary: false }),
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'variant.barcode_added',
          entityType: 'variant',
          entityId: variantId,
          changes: { after: { barcode } },
        },
        manager,
      );
      return saved;
    });
  }

  async remove(
    tenantId: string,
    productId: string,
    variantId: string,
    barcodeId: string,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.findVariant(manager, tenantId, productId, variantId);
      const repo = manager.getRepository(ProductBarcode);
      const row = await repo.findOne({
        where: { id: barcodeId, tenantId, variantId },
      });
      if (!row) {
        throw new NotFoundException('Barcode not found');
      }
      if (row.isPrimary) {
        throw new BadRequestException(
          "This is the variant's primary barcode. Change or clear it on the variant instead.",
        );
      }
      await repo.delete({ id: row.id, tenantId });
      await this.auditService.record(
        {
          tenantId,
          action: 'variant.barcode_removed',
          entityType: 'variant',
          entityId: variantId,
          changes: { before: { barcode: row.barcode } },
        },
        manager,
      );
    });
  }

  /**
   * 409 when the barcode already belongs to another variant of the store
   * (as its primary barcode or as an extra one).
   */
  async assertBarcodeFree(
    manager: EntityManager,
    tenantId: string,
    barcode: string,
    exceptVariantId?: string | null,
  ): Promise<void> {
    const owner = await this.findOwner(manager, tenantId, barcode);
    if (owner && owner.id !== exceptVariantId) {
      throw new ConflictException(
        `Barcode ${barcode} is already used by ${owner.sku}`,
      );
    }
  }

  /** The variant that currently answers to this barcode, if any */
  async findOwner(
    manager: EntityManager,
    tenantId: string,
    barcode: string,
  ): Promise<{ id: string; sku: string } | null> {
    barcode = normalizeBarcode(barcode) ?? '';
    const variants = manager.getRepository(ProductVariant);
    const row = await manager.getRepository(ProductBarcode).findOne({
      where: { tenantId, barcode },
    });
    if (row) {
      const variant = await variants.findOne({
        where: { id: row.variantId, tenantId },
        select: { id: true, sku: true },
      });
      if (variant) return variant;
    }
    // Legacy rows whose primary barcode isn't mirrored yet
    return variants.findOne({
      where: { tenantId, barcode },
      select: { id: true, sku: true },
    });
  }

  /**
   * Keep the isPrimary row in line with product_variants.barcode.
   * Call inside the transaction that changes the variant's barcode;
   * `undefined` means the barcode isn't being changed.
   */
  async syncPrimary(
    manager: EntityManager,
    tenantId: string,
    variantId: string,
    rawBarcode: string | null | undefined,
  ): Promise<void> {
    if (rawBarcode === undefined) return;
    const barcode = normalizeBarcode(rawBarcode);
    const repo = manager.getRepository(ProductBarcode);

    if (barcode) {
      await this.assertBarcodeFree(manager, tenantId, barcode, variantId);
    }
    // Remove the previous primary row, unless it's the same barcode
    await repo.delete({
      tenantId,
      variantId,
      isPrimary: true,
      ...(barcode && { barcode: Not(barcode) }),
    });
    if (!barcode) return;

    const existing = await repo.findOne({
      where: { tenantId, variantId, barcode },
    });
    if (existing) {
      if (!existing.isPrimary) {
        await repo.update({ id: existing.id, tenantId }, { isPrimary: true });
      }
      return;
    }
    await this.saveOrConflict(
      manager,
      repo.create({ tenantId, variantId, barcode, isPrimary: true }),
    );
  }

  private async findVariant(
    manager: EntityManager,
    tenantId: string,
    productId: string,
    variantId: string,
  ): Promise<ProductVariant> {
    const variant = await manager.getRepository(ProductVariant).findOne({
      where: { id: variantId, productId, tenantId },
    });
    if (!variant) {
      throw new NotFoundException('Variant not found');
    }
    return variant;
  }

  private async saveOrConflict(
    manager: EntityManager,
    row: ProductBarcode,
  ): Promise<ProductBarcode> {
    try {
      return await manager.getRepository(ProductBarcode).save(row);
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException(
          `Barcode ${row.barcode} is already used by another product`,
        );
      }
      throw error;
    }
  }
}
