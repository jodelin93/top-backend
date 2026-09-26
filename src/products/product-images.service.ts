import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { ProductImage } from '../database/entities/product-image.entity';
import { Product } from '../database/entities/product.entity';
import { ProductVariant } from '../database/entities/product-variant.entity';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';
import { detectImageType, MAX_IMAGE_BYTES } from '../storage/image-validation';

export const MAX_IMAGES_PER_PRODUCT = 10;

export interface UploadedImageFile {
  buffer: Buffer;
  size: number;
  originalname?: string;
}

/**
 * Product photos kept in object storage. The primary image is also copied to
 * each variant's imageUrl, which the POS grid shows.
 */
@Injectable()
export class ProductImagesService {
  private readonly logger = new Logger(ProductImagesService.name);

  constructor(
    private dataSource: DataSource,
    private storage: StorageService,
    private auditService: AuditService,
  ) {}

  list(tenantId: string, productId: string): Promise<ProductImage[]> {
    return this.dataSource.getRepository(ProductImage).find({
      where: { tenantId, productId },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });
  }

  async upload(
    tenantId: string,
    productId: string,
    file: UploadedImageFile | undefined,
    altText?: string,
  ): Promise<ProductImage> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Choose an image file to upload');
    }
    if (file.size > MAX_IMAGE_BYTES || file.buffer.length > MAX_IMAGE_BYTES) {
      throw new PayloadTooLargeException(
        `Images can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`,
      );
    }
    const type = detectImageType(file.buffer);
    if (!type) {
      throw new UnsupportedMediaTypeException(
        'Only JPEG, PNG and WebP images can be uploaded',
      );
    }
    await this.findProduct(this.dataSource.manager, tenantId, productId);
    const existing = await this.list(tenantId, productId);
    if (existing.length >= MAX_IMAGES_PER_PRODUCT) {
      throw new BadRequestException(
        `A product can have at most ${MAX_IMAGES_PER_PRODUCT} images`,
      );
    }

    const key = this.storage.newKey(
      `products/${tenantId}/${productId}`,
      type.extension,
    );
    await this.storage.put(key, file.buffer, type.contentType);

    try {
      return await this.dataSource.transaction(async (manager) => {
        // Lock the product so concurrent uploads can't exceed the limit
        await this.findProduct(manager, tenantId, productId, true);
        const repo = manager.getRepository(ProductImage);
        const current = await repo.find({ where: { tenantId, productId } });
        if (current.length >= MAX_IMAGES_PER_PRODUCT) {
          throw new BadRequestException(
            `A product can have at most ${MAX_IMAGES_PER_PRODUCT} images`,
          );
        }
        const image = await repo.save(
          repo.create({
            tenantId,
            productId,
            url: this.storage.publicUrl(key),
            storageKey: key,
            contentType: type.contentType,
            sizeBytes: file.buffer.length,
            altText: altText?.trim().slice(0, 255) || null,
            isPrimary: current.length === 0,
            sortOrder: current.reduce(
              (max, i) => Math.max(max, i.sortOrder + 1),
              0,
            ),
          } as Partial<ProductImage>),
        );
        await this.syncVariantImages(manager, tenantId, productId);
        await this.auditService.record(
          {
            tenantId,
            action: 'product.image_added',
            entityType: 'product',
            entityId: productId,
            changes: { after: { imageId: image.id, url: image.url } },
            metadata: {
              sizeBytes: image.sizeBytes,
              contentType: image.contentType,
            },
          },
          manager,
        );
        return image;
      });
    } catch (error) {
      // Don't leave an orphaned object behind
      await this.storage.delete(key);
      throw error;
    }
  }

  async update(
    tenantId: string,
    productId: string,
    imageId: string,
    dto: { altText?: string | null; isPrimary?: boolean },
  ): Promise<ProductImage> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ProductImage);
      const image = await this.findImage(manager, tenantId, productId, imageId);
      if (dto.altText !== undefined) {
        image.altText = dto.altText?.trim().slice(0, 255) || null;
      }
      if (dto.isPrimary === true && !image.isPrimary) {
        await repo.update({ tenantId, productId }, { isPrimary: false });
        image.isPrimary = true;
      }
      const saved = await repo.save(image);
      await this.syncVariantImages(manager, tenantId, productId);
      await this.auditService.record(
        {
          tenantId,
          action: 'product.image_updated',
          entityType: 'product',
          entityId: productId,
          changes: { after: { imageId, ...dto } },
        },
        manager,
      );
      return saved;
    });
  }

  /** Set the display order; imageIds must list every image of the product */
  async reorder(
    tenantId: string,
    productId: string,
    imageIds: string[],
  ): Promise<ProductImage[]> {
    await this.dataSource.transaction(async (manager) => {
      await this.findProduct(manager, tenantId, productId, true);
      const repo = manager.getRepository(ProductImage);
      const images = await repo.find({ where: { tenantId, productId } });
      const ids = new Set(images.map((i) => i.id));
      if (
        imageIds.length !== images.length ||
        new Set(imageIds).size !== imageIds.length ||
        !imageIds.every((id) => ids.has(id))
      ) {
        throw new BadRequestException(
          'Send every image of the product exactly once',
        );
      }
      for (const [index, id] of imageIds.entries()) {
        await repo.update({ id, tenantId }, { sortOrder: index });
      }
      await this.auditService.record(
        {
          tenantId,
          action: 'product.images_reordered',
          entityType: 'product',
          entityId: productId,
          changes: { after: { imageIds } },
        },
        manager,
      );
    });
    return this.list(tenantId, productId);
  }

  async remove(
    tenantId: string,
    productId: string,
    imageId: string,
  ): Promise<void> {
    const removed = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(ProductImage);
      const image = await this.findImage(manager, tenantId, productId, imageId);
      await repo.delete({ id: image.id, tenantId });
      if (image.isPrimary) {
        // Promote the next image in order
        const next = await repo.findOne({
          where: { tenantId, productId },
          order: { sortOrder: 'ASC', createdAt: 'ASC' },
        });
        if (next) {
          await repo.update({ id: next.id, tenantId }, { isPrimary: true });
        }
      }
      await this.syncVariantImages(manager, tenantId, productId, [image.url]);
      await this.auditService.record(
        {
          tenantId,
          action: 'product.image_removed',
          entityType: 'product',
          entityId: productId,
          changes: { before: { imageId, url: image.url } },
        },
        manager,
      );
      return image;
    });
    // After commit: the row is gone, so the object is no longer referenced
    if (removed.storageKey) {
      await this.storage.delete(removed.storageKey);
    }
  }

  /**
   * Copy the primary image URL to the product's variants. Variants with their own
   * image (set elsewhere) keep it; ones showing a previous product image follow along.
   */
  async syncVariantImages(
    manager: EntityManager,
    tenantId: string,
    productId: string,
    removedUrls: string[] = [],
  ): Promise<void> {
    const images = await manager.getRepository(ProductImage).find({
      where: { tenantId, productId },
    });
    const primary = images.find((i) => i.isPrimary) ?? null;
    const managedUrls = [...images.map((i) => i.url), ...removedUrls];
    await manager
      .createQueryBuilder()
      .update(ProductVariant)
      .set({ imageUrl: (primary?.url ?? null) as unknown as string })
      .where('"tenantId" = :tenantId AND "productId" = :productId', {
        tenantId,
        productId,
      })
      .andWhere('("imageUrl" IS NULL OR "imageUrl" = ANY(:managedUrls))', {
        managedUrls,
      })
      .execute();
  }

  private async findProduct(
    manager: EntityManager,
    tenantId: string,
    productId: string,
    lock = false,
  ): Promise<void> {
    const qb = manager
      .getRepository(Product)
      .createQueryBuilder('product')
      .select('product.id')
      .where('product.id = :productId AND product.tenantId = :tenantId', {
        productId,
        tenantId,
      });
    if (lock) qb.setLock('pessimistic_write');
    if (!(await qb.getOne())) {
      throw new NotFoundException('Product not found');
    }
  }

  private async findImage(
    manager: EntityManager,
    tenantId: string,
    productId: string,
    imageId: string,
  ): Promise<ProductImage> {
    const image = await manager.getRepository(ProductImage).findOne({
      where: { id: imageId, tenantId, productId },
    });
    if (!image) {
      throw new NotFoundException('Image not found');
    }
    return image;
  }
}
