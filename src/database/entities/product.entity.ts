import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
  OneToMany,
} from 'typeorm';
import { BaseEntityWithVersion } from './base.entity';
import { Tenant } from './tenant.entity';
import { Category } from './category.entity';
import { ProductVariant } from './product-variant.entity';
import { TaxCategory } from './tax-category.entity';
import { ProductUnit } from './product-unit.entity';
import type { ProductImage } from './product-image.entity';

// Attribute values a variable product's variants are generated from
export interface VariantAttributeSelection {
  attributeId: string;
  values: string[];
}

export enum ProductType {
  SIMPLE = 'simple',
  VARIABLE = 'variable',
  COMPOSITE = 'composite',
}

export enum ProductStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  DISCONTINUED = 'discontinued',
}

@Entity('products')
@Unique('uq_product_sku', ['tenantId', 'sku'])
@Unique('uq_product_id_tenant', ['id', 'tenantId'])
@Index(['tenantId'])
@Index(['categoryId'])
@Index(['productType'])
export class Product extends BaseEntityWithVersion {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  sku: string;

  @Column({ type: 'jsonb', nullable: false })
  name: Record<string, string>;

  @Column({ type: 'jsonb', nullable: true })
  description: Record<string, string>;

  @Column({
    type: 'enum',
    enum: ProductType,
    default: ProductType.SIMPLE,
    nullable: false,
  })
  productType: ProductType;

  @Column({ type: 'uuid', nullable: true })
  categoryId: string;

  // Null: the store's default tax rate applies
  @Column({ type: 'uuid', nullable: true })
  taxCategoryId: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  brand: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  manufacturer: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  barcode: string;

  @Column({ type: 'boolean', default: true, nullable: false })
  isSerialized: boolean;

  @Column({ type: 'boolean', default: false, nullable: false })
  isBatchTracked: boolean;

  // Historical only (D018: negative stock is never allowed); no longer read by
  // any stock decision and always false
  @Column({ type: 'boolean', default: false, nullable: false })
  allowBackorder: boolean;

  // Free labels to group and filter products (trimmed, lower-case, unique)
  @Column({ type: 'text', array: true, default: () => "'{}'", nullable: false })
  tags: string[];

  // Default unit of measure (units table); null = sold by the piece
  @Column({ type: 'uuid', nullable: true })
  unitId: string | null;

  // False for services and other non-stock items: sales, returns and voids never
  // move or reserve stock for them, and the POS shows no stock count
  @Column({ type: 'boolean', default: true, nullable: false })
  isStockTracked: boolean;

  @Column({ type: 'int', nullable: true })
  minStockLevel: number;

  @Column({ type: 'int', nullable: true })
  maxStockLevel: number;

  @Column({ type: 'int', nullable: true })
  reorderPoint: number;

  @Column({ type: 'int', nullable: true })
  reorderQuantity: number;

  @Column({ type: 'numeric', precision: 10, scale: 4, nullable: true })
  weight: number;

  @Column({ type: 'varchar', length: 10, nullable: true })
  weightUnit: string;

  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
  length: number;

  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
  width: number;

  @Column({ type: 'numeric', precision: 10, scale: 2, nullable: true })
  height: number;

  @Column({ type: 'varchar', length: 10, nullable: true })
  dimensionUnit: string;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  metadata: Record<string, any>;

  @Column({ type: 'jsonb', nullable: true })
  variantAttributes: VariantAttributeSelection[] | null;

  @Column({
    type: 'enum',
    enum: ProductStatus,
    default: ProductStatus.ACTIVE,
    nullable: false,
  })
  status: ProductStatus;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => Category, { onDelete: 'SET NULL' })
  @JoinColumn([
    { name: 'categoryId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  category: Category;

  @ManyToOne(() => TaxCategory, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'taxCategoryId',
    foreignKeyConstraintName: 'FK_products_tax_category',
  })
  taxCategory: TaxCategory | null;

  // Unit of measure (measured items: allowsDecimals, e.g. kg with precision 3)
  @ManyToOne(() => ProductUnit, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'unitId', foreignKeyConstraintName: 'fk_products_unit' })
  unit: ProductUnit | null;

  @OneToMany(() => ProductVariant, (variant) => variant.product)
  variants: ProductVariant[];

  // Loaded by list queries (not a column)
  primaryImage?: ProductImage | null;

  // Branches that sell it (product_branches); empty = every branch. Loaded by findOne.
  branchIds?: string[];
}
