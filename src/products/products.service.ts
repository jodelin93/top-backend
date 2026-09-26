import { AuditService } from '../audit/audit.service';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository, In } from 'typeorm';
import {
  Product,
  ProductStatus,
  VariantAttributeSelection,
} from '../database/entities/product.entity';
import {
  ProductVariant,
  VariantStatus,
} from '../database/entities/product-variant.entity';
import { Category } from '../database/entities/category.entity';
import {
  AttributeDefinition,
  AttributeType,
} from '../database/entities/attribute-definition.entity';
import { AttributeValue } from '../database/entities/attribute-value.entity';
import { ProductImage } from '../database/entities/product-image.entity';
import { TaxCategory } from '../database/entities/tax-category.entity';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { CreateVariantDto, UpdateVariantDto } from './dto/create-variant.dto';
import { GenerateVariantsDto } from './dto/generate-variants.dto';
import { ProductType } from '../database/entities/product.entity';
import {
  normalizeBarcode,
  ProductBarcodesService,
} from './product-barcodes.service';
import {
  cartesian,
  cleanValues,
  combinationKey,
  MAX_GENERATED_VARIANTS,
  skuPart,
  uniqueSku,
} from './variant-generator';
import { ProductUnit } from '../database/entities/product-unit.entity';
import { ProductBranch } from '../database/entities/product-branch.entity';
import { Branch } from '../database/entities/branch.entity';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { normalizePlu } from './weighted-barcode';
import {
  buildLabels,
  normalizeTags,
  parseTagFilter,
  soldAtBranchSql,
} from './catalog-rules';
import { PrintLabelsDto } from './dto/labels.dto';
import { containsPattern } from '../common/utils/like';

export interface GeneratedVariantPreview {
  sku: string;
  name: string;
  attributes: { attributeId: string; attributeName: string; value: string }[];
  // An existing variant already has this combination
  exists: boolean;
  variantId: string | null;
}

export interface GenerateVariantsResult {
  dryRun: boolean;
  combinations: GeneratedVariantPreview[];
  toCreate: number;
  existing: number;
  created: ProductVariant[];
}

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productRepository: Repository<Product>,
    @InjectRepository(ProductVariant)
    private variantRepository: Repository<ProductVariant>,
    @InjectRepository(Category)
    private categoryRepository: Repository<Category>,
    @InjectRepository(AttributeDefinition)
    private attributeRepository: Repository<AttributeDefinition>,
    @InjectRepository(AttributeValue)
    private attributeValueRepository: Repository<AttributeValue>,
    private dataSource: DataSource,
    private auditService: AuditService,
    private barcodes: ProductBarcodesService,
  ) {}

  /**
   * Create a new product
   */
  async create(
    tenantId: string,
    createProductDto: CreateProductDto,
  ): Promise<Product> {
    // Check if SKU already exists for this tenant
    const existingProduct = await this.productRepository.findOne({
      where: { tenantId, sku: createProductDto.sku },
    });

    if (existingProduct) {
      throw new ConflictException(
        `Product with SKU ${createProductDto.sku} already exists`,
      );
    }

    // Validate category if provided
    if (createProductDto.categoryId) {
      const category = await this.categoryRepository.findOne({
        where: { id: createProductDto.categoryId, tenantId },
      });

      if (!category) {
        throw new NotFoundException('Category not found');
      }
    }
    await this.assertTaxCategory(tenantId, createProductDto.taxCategoryId);
    await this.assertUnit(tenantId, createProductDto.unitId);
    await this.assertBranches(tenantId, createProductDto.branchIds);

    const {
      price,
      cost,
      branchIds,
      pluCode: rawPlu,
      // D018: ignored, negative stock is never allowed
      allowBackorder: _allowBackorder,
      ...productData
    } = createProductDto;
    void _allowBackorder;
    const pluCode = this.pluOf(rawPlu);
    if (pluCode) await this.assertPluFree(tenantId, pluCode);
    if (productData.barcode !== undefined) {
      productData.barcode = normalizeBarcode(productData.barcode) ?? undefined;
    }
    if (productData.tags !== undefined) {
      productData.tags = normalizeTags(productData.tags);
    }

    if (
      (productData.productType ?? ProductType.SIMPLE) === ProductType.SIMPLE
    ) {
      await this.assertVariantSkuFree(tenantId, productData.sku);
    }

    const productId = await this.dataSource.transaction(async (manager) => {
      const product = await manager.save(
        manager.create(Product, {
          ...productData,
          // D018: negative stock is never allowed (column kept for history)
          allowBackorder: false,
          tenantId,
          status: ProductStatus.ACTIVE,
        }),
      );
      if (branchIds !== undefined) {
        await this.saveAssortment(manager, tenantId, product.id, branchIds);
      }

      // Simple products are sold through a single default variant carrying the price
      if (product.productType === ProductType.SIMPLE) {
        const variant = await manager.save(
          manager.create(ProductVariant, {
            tenantId,
            productId: product.id,
            sku: product.sku,
            barcode: product.barcode,
            pluCode: pluCode ?? null,
            price: price ?? 0,
            cost,
            status: VariantStatus.ACTIVE,
          }),
        );
        await this.barcodes.syncPrimary(
          manager,
          tenantId,
          variant.id,
          product.barcode ?? null,
        );
      }

      await this.auditService.record(
        {
          tenantId,
          action: 'product.created',
          entityType: 'product',
          entityId: product.id,
          changes: { after: { ...product, price, cost, branchIds } },
        },
        manager,
      );
      return product.id;
    });

    return this.findOne(tenantId, productId);
  }

  /**
   * Find all products for a tenant with optional filtering
   */
  async findAll(
    tenantId: string,
    filters?: {
      categoryId?: string;
      status?: ProductStatus;
      search?: string;
      productType?: string;
      taxCategoryId?: string;
      tags?: string;
      branchId?: string;
      unitId?: string;
    },
  ): Promise<Product[]> {
    const query = this.productRepository
      .createQueryBuilder('product')
      .where('product.tenantId = :tenantId', { tenantId })
      .leftJoinAndSelect('product.category', 'category')
      .leftJoinAndSelect('product.taxCategory', 'taxCategory')
      .leftJoinAndSelect('product.variants', 'variants')
      .leftJoinAndMapOne(
        'product.primaryImage',
        ProductImage,
        'primaryImage',
        'primaryImage.productId = product.id AND primaryImage.tenantId = product.tenantId AND primaryImage.isPrimary = true',
      );

    if (filters?.categoryId) {
      query.andWhere('product.categoryId = :categoryId', {
        categoryId: filters.categoryId,
      });
    }

    if (filters?.taxCategoryId) {
      query.andWhere('product.taxCategoryId = :taxCategoryId', {
        taxCategoryId: filters.taxCategoryId,
      });
    }

    if (filters?.status) {
      query.andWhere('product.status = :status', { status: filters.status });
    }

    const tags = parseTagFilter(filters?.tags);
    if (tags.length) {
      // Any of the tags
      query.andWhere('product.tags && :tags::text[]', { tags });
    }

    if (filters?.branchId) {
      query.andWhere(soldAtBranchSql('product'), {
        branchId: filters.branchId,
      });
    }

    if (filters?.unitId) {
      query.andWhere('product.unitId = :unitId', { unitId: filters.unitId });
    }

    if (filters?.productType) {
      query.andWhere('product.productType = :productType', {
        productType: filters.productType,
      });
    }

    if (filters?.search) {
      // Any barcode of any variant matches too
      query.andWhere(
        `(product.sku ILIKE :search OR product.name::text ILIKE :search OR product.barcode ILIKE :search
          OR EXISTS (SELECT 1 FROM product_barcodes pb
            JOIN product_variants pv ON pv.id = pb."variantId"
            WHERE pv."productId" = product.id AND pb."tenantId" = product."tenantId"
              AND pb.barcode ILIKE :search))`,
        { search: containsPattern(filters.search) },
      );
    }

    return query.getMany();
  }

  /**
   * Find a single product by ID
   */
  async findOne(tenantId: string, id: string): Promise<Product> {
    const product = await this.productRepository.findOne({
      where: { id, tenantId },
      relations: {
        category: true,
        taxCategory: true,
        variants: {
          attributeValues: {
            attribute: true,
          },
          barcodes: true,
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    product.branchIds = await this.assortmentOf(tenantId, product.id);
    return product;
  }

  /** Branches that sell the product (empty = every branch) */
  async assortmentOf(tenantId: string, productId: string): Promise<string[]> {
    const rows = await this.dataSource.getRepository(ProductBranch).find({
      where: { tenantId, productId },
      select: { branchId: true },
    });
    return rows.map((r) => r.branchId).sort();
  }

  /**
   * Label sheet data: one label per copy with name, SKU, code (barcode, else
   * SKU) and selling price. Never includes costs.
   */
  async labels(tenantId: string, dto: PrintLabelsDto) {
    const ids = [...new Set(dto.items.map((i) => i.variantId))];
    const variants = await this.variantRepository.find({
      where: { tenantId, id: In(ids) },
      relations: { product: true },
    });
    if (variants.length !== ids.length) {
      throw new NotFoundException('One or more variants were not found');
    }
    return buildLabels(
      variants.map((v) => ({
        variantId: v.id,
        sku: v.sku,
        barcode: v.barcode ?? null,
        productName: v.product?.name ?? null,
        variantName: v.name ?? null,
        price:
          v.price === null || v.price === undefined ? null : Number(v.price),
      })),
      dto.items,
      dto.language ?? 'en',
    );
  }

  /**
   * Find product by SKU
   */
  async findBySku(tenantId: string, sku: string): Promise<Product> {
    const product = await this.productRepository.findOne({
      where: { tenantId, sku },
      relations: {
        variants: true,
      },
    });

    if (!product) {
      throw new NotFoundException(`Product with SKU ${sku} not found`);
    }

    return product;
  }

  /**
   * Update a product
   */
  async update(
    tenantId: string,
    id: string,
    updateProductDto: UpdateProductDto,
  ): Promise<Product> {
    const product = await this.findOne(tenantId, id);

    // Check SKU uniqueness if being updated
    if (updateProductDto.sku && updateProductDto.sku !== product.sku) {
      const existingProduct = await this.productRepository.findOne({
        where: { tenantId, sku: updateProductDto.sku },
      });

      if (existingProduct) {
        throw new ConflictException(
          `Product with SKU ${updateProductDto.sku} already exists`,
        );
      }

      const ownVariantIds = product.variants.map((v) => v.id);
      await this.assertVariantSkuFree(
        tenantId,
        updateProductDto.sku,
        ownVariantIds,
      );
    }

    // Validate category if being updated
    if (updateProductDto.categoryId) {
      const category = await this.categoryRepository.findOne({
        where: { id: updateProductDto.categoryId, tenantId },
      });

      if (!category) {
        throw new NotFoundException('Category not found');
      }
    }
    await this.assertTaxCategory(tenantId, updateProductDto.taxCategoryId);
    await this.assertUnit(tenantId, updateProductDto.unitId);
    await this.assertBranches(tenantId, updateProductDto.branchIds);

    const {
      price,
      cost,
      branchIds,
      pluCode: rawPlu,
      // D018: ignored, negative stock is never allowed
      allowBackorder: _allowBackorder,
      ...productData
    } = updateProductDto;
    void _allowBackorder;
    const pluCode = rawPlu === undefined ? undefined : this.pluOf(rawPlu);
    if (pluCode) {
      const defaultVariant = [...(product.variants ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder,
      )[0];
      await this.assertPluFree(tenantId, pluCode, defaultVariant?.id);
    }
    if (productData.barcode !== undefined) {
      productData.barcode = normalizeBarcode(productData.barcode) as string;
    }
    if (productData.tags !== undefined) {
      productData.tags = normalizeTags(productData.tags);
    }

    await this.dataSource.transaction(async (manager) => {
      // Update columns only, so the loaded relations (variants, category) aren't re-saved
      if (Object.keys(productData).length > 0) {
        await manager.update(Product, { id, tenantId }, productData);
      }
      if (branchIds !== undefined) {
        await this.saveAssortment(manager, tenantId, id, branchIds);
      }

      // Keep the default variant of a simple product in sync with the product
      const productType = productData.productType ?? product.productType;
      if (productType === ProductType.SIMPLE) {
        const defaultVariant = [...product.variants].sort(
          (a, b) => a.sortOrder - b.sortOrder,
        )[0];
        const variantData = {
          sku: productData.sku ?? product.sku,
          barcode:
            productData.barcode !== undefined
              ? productData.barcode
              : product.barcode,
          ...(price !== undefined && { price }),
          ...(cost !== undefined && { cost }),
          ...(pluCode !== undefined && { pluCode }),
        };
        if (defaultVariant) {
          await manager.update(
            ProductVariant,
            { id: defaultVariant.id, tenantId },
            variantData,
          );
          await this.barcodes.syncPrimary(
            manager,
            tenantId,
            defaultVariant.id,
            productData.barcode,
          );
        } else {
          const variant = await manager.save(
            manager.create(ProductVariant, {
              tenantId,
              productId: id,
              price: 0,
              ...variantData,
              status: VariantStatus.ACTIVE,
            }),
          );
          await this.barcodes.syncPrimary(
            manager,
            tenantId,
            variant.id,
            variantData.barcode ?? null,
          );
        }
      }
    });

    const updated = await this.findOne(tenantId, id);
    await this.auditService.record({
      tenantId,
      action: 'product.updated',
      entityType: 'product',
      entityId: id,
      changes: { before: product, after: updated },
    });
    return updated;
  }

  /**
   * Soft delete a product (set status to discontinued)
   */
  async remove(tenantId: string, id: string): Promise<void> {
    await this.findOne(tenantId, id);
    await this.dataSource.transaction(async (manager) => {
      await manager.update(
        Product,
        { id, tenantId },
        { status: ProductStatus.DISCONTINUED },
      );
      await manager.update(
        ProductVariant,
        { productId: id, tenantId },
        { status: VariantStatus.DISCONTINUED },
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'product.discontinued',
          entityType: 'product',
          entityId: id,
        },
        manager,
      );
    });
  }

  /**
   * Create a product variant
   */
  async createVariant(
    tenantId: string,
    createVariantDto: CreateVariantDto,
  ): Promise<ProductVariant> {
    // Validate product exists
    await this.findOne(tenantId, createVariantDto.productId);

    // Check SKU uniqueness
    const existingVariant = await this.variantRepository.findOne({
      where: { tenantId, sku: createVariantDto.sku },
    });

    if (existingVariant) {
      throw new ConflictException(
        `Variant with SKU ${createVariantDto.sku} already exists`,
      );
    }

    const { attributes, pluCode: rawPlu, ...variantData } = createVariantDto;
    const barcode = normalizeBarcode(variantData.barcode);
    const pluCode = this.pluOf(rawPlu);
    if (pluCode) await this.assertPluFree(tenantId, pluCode);
    const key = attributes?.length
      ? combinationKey(
          attributes.map((a) => ({
            attributeId: a.attributeId,
            value: String(a.value),
          })),
        )
      : null;
    if (key) {
      const clash = await this.variantRepository.findOne({
        where: {
          tenantId,
          productId: createVariantDto.productId,
          combinationKey: key,
        },
        select: { id: true, sku: true },
      });
      if (clash) {
        throw new ConflictException(
          `Variant ${clash.sku} already has these options`,
        );
      }
    }

    const variantId = await this.dataSource.transaction(async (manager) => {
      const savedVariant = await this.saveVariantOrConflict(
        manager,
        manager.create(ProductVariant, {
          ...variantData,
          barcode: barcode ?? undefined,
          pluCode,
          combinationKey: key,
          tenantId,
          status: VariantStatus.ACTIVE,
        }),
      );
      await this.barcodes.syncPrimary(
        manager,
        tenantId,
        savedVariant.id,
        barcode,
      );

      // Create attribute values if provided
      if (attributes && attributes.length > 0) {
        await this.assertAttributes(
          manager,
          tenantId,
          attributes.map((a) => a.attributeId),
        );
        await manager.save(
          attributes.map((attr) =>
            manager.create(AttributeValue, {
              tenantId,
              variantId: savedVariant.id,
              attributeId: attr.attributeId,
              value: attr.value,
            }),
          ),
        );
      }
      return savedVariant.id;
    });

    const variantWithRelations = await this.variantRepository.findOne({
      where: { id: variantId, tenantId },
      relations: {
        attributeValues: {
          attribute: true,
        },
        barcodes: true,
      },
    });

    if (!variantWithRelations) {
      throw new NotFoundException('Variant not found after creation');
    }

    return variantWithRelations;
  }

  /**
   * Generate the variants of a variable product from attribute values:
   * every combination is previewed (dryRun) or created, skipping combinations
   * an existing variant already has. The selection is remembered on the product.
   */
  async generateVariants(
    tenantId: string,
    productId: string,
    dto: GenerateVariantsDto,
  ): Promise<GenerateVariantsResult> {
    const product = await this.findOne(tenantId, productId);
    if (product.productType !== ProductType.VARIABLE) {
      throw new BadRequestException(
        'Variants can only be generated for variable products',
      );
    }

    const selections: VariantAttributeSelection[] = dto.attributes.map((a) => ({
      attributeId: a.attributeId,
      values: cleanValues(a.values),
    }));
    const attributeIds = selections.map((s) => s.attributeId);
    if (new Set(attributeIds).size !== attributeIds.length) {
      throw new BadRequestException('Each attribute can only be listed once');
    }
    const attributes = await this.attributeRepository.find({
      where: { id: In(attributeIds), tenantId },
    });
    const byId = new Map(attributes.map((a) => [a.id, a]));
    for (const selection of selections) {
      const attribute = byId.get(selection.attributeId);
      if (!attribute) {
        throw new BadRequestException('Attribute not found');
      }
      if (!attribute.isVariantDefining) {
        throw new BadRequestException(
          `${attribute.name?.en ?? attribute.code} is not a variant attribute`,
        );
      }
      if (selection.values.length === 0) {
        throw new BadRequestException(
          `Choose at least one value for ${attribute.name?.en ?? attribute.code}`,
        );
      }
      const restricted =
        attribute.options?.length &&
        [
          AttributeType.SELECT,
          AttributeType.MULTISELECT,
          AttributeType.COLOR,
        ].includes(attribute.attributeType);
      if (restricted) {
        const allowed = new Set(attribute.options!.map((o) => o.toLowerCase()));
        const invalid = selection.values.filter(
          (v) => !allowed.has(v.toLowerCase()),
        );
        if (invalid.length) {
          throw new BadRequestException(
            `${invalid.join(', ')} is not an option of ${attribute.name?.en ?? attribute.code}`,
          );
        }
      }
    }

    const combos = cartesian(selections);
    if (combos.length > MAX_GENERATED_VARIANTS) {
      throw new BadRequestException(
        `That would create ${combos.length} variants; the limit is ${MAX_GENERATED_VARIANTS}`,
      );
    }

    // Combinations existing variants already have
    const existingByKey = new Map<string, ProductVariant>();
    for (const variant of product.variants) {
      const parts = (variant.attributeValues ?? [])
        .filter((v) => attributeIds.includes(v.attributeId))
        .map((v) => ({ attributeId: v.attributeId, value: v.value }));
      if (parts.length === attributeIds.length) {
        existingByKey.set(combinationKey(parts), variant);
      }
    }

    const takenSkus = new Set(
      (
        await this.variantRepository.find({
          where: { tenantId },
          select: { sku: true },
        })
      ).map((v) => v.sku.toUpperCase()),
    );

    const combinations: GeneratedVariantPreview[] = combos.map((parts) => {
      const existing = existingByKey.get(combinationKey(parts));
      return {
        sku: existing
          ? existing.sku
          : uniqueSku(
              `${product.sku}-${parts.map((p) => skuPart(p.value)).join('-')}`,
              takenSkus,
            ),
        name: parts.map((p) => p.value).join(' / '),
        attributes: parts.map((p) => {
          const attribute = byId.get(p.attributeId)!;
          return {
            attributeId: p.attributeId,
            attributeName: attribute.name?.en ?? attribute.code,
            value: p.value,
          };
        }),
        exists: !!existing,
        variantId: existing?.id ?? null,
      };
    });
    const missing = combinations.filter((c) => !c.exists);

    const result: GenerateVariantsResult = {
      dryRun: !!dto.dryRun,
      combinations,
      toCreate: missing.length,
      existing: combinations.length - missing.length,
      created: [],
    };
    if (dto.dryRun) {
      return result;
    }

    const createdIds = await this.dataSource.transaction(async (manager) => {
      let sortOrder = product.variants.reduce(
        (max, v) => Math.max(max, v.sortOrder + 1),
        0,
      );
      const ids: string[] = [];
      for (const combo of missing) {
        const variant = await this.saveVariantOrConflict(
          manager,
          manager.create(ProductVariant, {
            tenantId,
            productId,
            sku: combo.sku,
            combinationKey: combinationKey(combo.attributes),
            name: { en: combo.name },
            price: dto.price ?? 0,
            cost: dto.cost,
            sortOrder: sortOrder++,
            status: VariantStatus.ACTIVE,
          }),
        );
        await manager.save(
          combo.attributes.map((a) =>
            manager.create(AttributeValue, {
              tenantId,
              variantId: variant.id,
              attributeId: a.attributeId,
              value: a.value,
            }),
          ),
        );
        ids.push(variant.id);
      }
      await manager.update(
        Product,
        { id: productId, tenantId },
        { variantAttributes: selections },
      );
      await this.auditService.record(
        {
          tenantId,
          action: 'product.variants_generated',
          entityType: 'product',
          entityId: productId,
          changes: { after: { variantAttributes: selections } },
          metadata: { created: ids.length, skipped: result.existing },
        },
        manager,
      );
      return ids;
    });

    result.created = createdIds.length
      ? await this.variantRepository.find({
          where: { tenantId, id: In(createdIds) },
          relations: { attributeValues: { attribute: true } },
          order: { sortOrder: 'ASC' },
        })
      : [];
    return result;
  }

  /** Unique option combination per product (uq_variant_combination) → 409 */
  private async saveVariantOrConflict(
    manager: EntityManager,
    variant: ProductVariant,
  ): Promise<ProductVariant> {
    try {
      return await manager.save(variant);
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION, 'uq_variant_combination')) {
        throw new ConflictException(
          'Another variant of this product already has these options',
        );
      }
      throw error;
    }
  }

  /** Replace the product's branch assortment (empty = sold everywhere) */
  private async saveAssortment(
    manager: EntityManager,
    tenantId: string,
    productId: string,
    branchIds: string[],
  ) {
    await manager.delete(ProductBranch, { tenantId, productId });
    const unique = [...new Set(branchIds)];
    if (unique.length) {
      await manager.insert(
        ProductBranch,
        unique.map((branchId) => ({ tenantId, productId, branchId })),
      );
    }
  }

  /** PLU as stored (digits, no leading zeros); null clears it */
  private pluOf(value: string | null | undefined): string | null {
    if (value === null || value === undefined || !String(value).trim()) {
      return null;
    }
    const plu = normalizePlu(value);
    if (!plu) throw new BadRequestException('PLU code must be 1 to 6 digits');
    return plu;
  }

  /** A PLU identifies one variant per store (scales print it in the barcode) */
  private async assertPluFree(
    tenantId: string,
    pluCode: string,
    exceptVariantId?: string,
  ) {
    const owner = await this.variantRepository.findOne({
      where: { tenantId, pluCode },
      select: { id: true, sku: true },
    });
    if (owner && owner.id !== exceptVariantId) {
      throw new ConflictException(
        `PLU ${pluCode} is already used by ${owner.sku}`,
      );
    }
  }

  private async assertUnit(
    tenantId: string,
    unitId: string | null | undefined,
  ) {
    if (!unitId) return;
    const exists = await this.dataSource
      .getRepository(ProductUnit)
      .exists({ where: { id: unitId, tenantId } });
    if (!exists) throw new NotFoundException('Unit not found');
  }

  private async assertBranches(
    tenantId: string,
    branchIds: string[] | undefined,
  ) {
    if (!branchIds?.length) return;
    const unique = [...new Set(branchIds)];
    const count = await this.dataSource
      .getRepository(Branch)
      .count({ where: { tenantId, id: In(unique) } });
    if (count !== unique.length) {
      throw new NotFoundException('Branch not found');
    }
  }

  private async assertVariantSkuFree(
    tenantId: string,
    sku: string,
    exceptIds: string[] = [],
  ) {
    const existing = await this.variantRepository.findOne({
      where: { tenantId, sku },
    });
    if (existing && !exceptIds.includes(existing.id)) {
      throw new ConflictException(`A variant with SKU ${sku} already exists`);
    }
  }

  // A tax category, when given, must belong to the store
  private async assertTaxCategory(
    tenantId: string,
    taxCategoryId: string | null | undefined,
  ) {
    if (!taxCategoryId) return;
    const exists = await this.dataSource
      .getRepository(TaxCategory)
      .exists({ where: { id: taxCategoryId, tenantId } });
    if (!exists) {
      throw new NotFoundException('Tax category not found');
    }
  }

  private async assertAttributes(
    manager: EntityManager,
    tenantId: string,
    attributeIds: string[],
  ) {
    const unique = [...new Set(attributeIds)];
    const count = await manager.count(AttributeDefinition, {
      where: { id: In(unique), tenantId },
    });
    if (count !== unique.length || unique.length !== attributeIds.length) {
      throw new BadRequestException('Invalid attributes');
    }
  }

  /**
   * Update a variant of a product
   */
  async updateVariant(
    tenantId: string,
    productId: string,
    variantId: string,
    dto: UpdateVariantDto,
  ): Promise<ProductVariant> {
    const variant = await this.variantRepository.findOne({
      where: { id: variantId, productId, tenantId },
    });
    if (!variant) {
      throw new NotFoundException('Variant not found');
    }

    if (dto.sku && dto.sku !== variant.sku) {
      const existing = await this.variantRepository.findOne({
        where: { tenantId, sku: dto.sku },
      });
      if (existing) {
        throw new ConflictException(
          `Variant with SKU ${dto.sku} already exists`,
        );
      }
    }

    const data = { ...dto };
    if (data.barcode !== undefined) {
      data.barcode = normalizeBarcode(data.barcode) as string;
    }
    if (data.pluCode !== undefined) {
      data.pluCode = this.pluOf(data.pluCode);
      if (data.pluCode)
        await this.assertPluFree(tenantId, data.pluCode, variantId);
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(ProductVariant, { id: variantId, tenantId }, data);
      await this.barcodes.syncPrimary(
        manager,
        tenantId,
        variantId,
        data.barcode,
      );
    });
    const updated = await this.variantRepository.findOneOrFail({
      where: { id: variantId, tenantId },
      relations: { attributeValues: { attribute: true }, barcodes: true },
    });
    await this.auditService.record({
      tenantId,
      action: 'variant.updated',
      entityType: 'variant',
      entityId: variantId,
      changes: { before: variant, after: updated },
    });
    return updated;
  }

  /**
   * Discontinue a variant (soft delete, it stays on past sales)
   */
  async removeVariant(
    tenantId: string,
    productId: string,
    variantId: string,
  ): Promise<void> {
    const result = await this.variantRepository.update(
      { id: variantId, productId, tenantId },
      { status: VariantStatus.DISCONTINUED },
    );
    if (!result.affected) {
      throw new NotFoundException('Variant not found');
    }
    await this.auditService.record({
      tenantId,
      action: 'variant.discontinued',
      entityType: 'variant',
      entityId: variantId,
    });
  }

  /**
   * Find variant by SKU
   */
  async findVariantBySku(
    tenantId: string,
    sku: string,
  ): Promise<ProductVariant> {
    const variant = await this.variantRepository.findOne({
      where: { tenantId, sku },
      relations: {
        product: true,
        attributeValues: {
          attribute: true,
        },
      },
    });

    if (!variant) {
      throw new NotFoundException(`Variant with SKU ${sku} not found`);
    }

    return variant;
  }

  /**
   * Find variant by any of its barcodes
   */
  async findVariantByBarcode(
    tenantId: string,
    barcode: string,
  ): Promise<ProductVariant> {
    const owner = await this.barcodes.findOwner(
      this.dataSource.manager,
      tenantId,
      normalizeBarcode(barcode) ?? '',
    );
    const variant = owner
      ? await this.variantRepository.findOne({
          where: { tenantId, id: owner.id },
          relations: {
            product: true,
            attributeValues: {
              attribute: true,
            },
          },
        })
      : null;

    if (!variant) {
      throw new NotFoundException(`Variant with barcode ${barcode} not found`);
    }

    return variant;
  }

  /**
   * Get all variants for a product
   */
  async getProductVariants(
    tenantId: string,
    productId: string,
  ): Promise<ProductVariant[]> {
    return this.variantRepository.find({
      where: { tenantId, productId },
      relations: {
        attributeValues: {
          attribute: true,
        },
        barcodes: true,
      },
      order: { sortOrder: 'ASC' },
    });
  }
}
