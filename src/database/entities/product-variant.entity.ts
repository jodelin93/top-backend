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
import { Product } from './product.entity';
import { AttributeValue } from './attribute-value.entity';
import { ProductBarcode } from './product-barcode.entity';

export enum VariantStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  DISCONTINUED = 'discontinued',
}

@Entity('product_variants')
@Unique('uq_variant_sku', ['tenantId', 'sku'])
@Unique('uq_variant_id_tenant', ['id', 'tenantId'])
@Index(['tenantId'])
@Index(['productId'])
@Index(['barcode'])
// A product can't have two variants with the same option combination
@Index('uq_variant_combination', ['tenantId', 'productId', 'combinationKey'], {
  unique: true,
  where: '"combinationKey" IS NOT NULL',
})
// A PLU (scale item code) identifies one variant per store
@Index('uq_variant_plu', ['tenantId', 'pluCode'], {
  unique: true,
  where: '"pluCode" IS NOT NULL',
})
export class ProductVariant extends BaseEntityWithVersion {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  productId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  sku: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  barcode: string;

  // PLU / scale item code (digits, no leading zeros) read from weighted and
  // price-embedded barcodes (GS1 prefixes 20–29)
  @Column({ type: 'varchar', length: 6, nullable: true })
  pluCode: string | null;

  @Column({ type: 'jsonb', nullable: true })
  name: Record<string, string>;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  cost: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  price: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  compareAtPrice: number;

  // Decimal for measured items (kg, m, l)
  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  stockQuantity: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  reservedQuantity: number;

  @Column({ type: 'int', nullable: true })
  minStockLevel: number;

  @Column({ type: 'int', nullable: true })
  maxStockLevel: number;

  @Column({ type: 'numeric', precision: 10, scale: 4, nullable: true })
  weight: number;

  @Column({ type: 'varchar', length: 10, nullable: true })
  weightUnit: string;

  // Shown on the POS grid; follows the product's primary image
  @Column({ type: 'varchar', length: 500, nullable: true })
  imageUrl: string;

  @Column({ type: 'int', default: 0, nullable: false })
  sortOrder: number;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  metadata: Record<string, any>;

  // Its attribute values as "attributeId=value|…" (sorted, trimmed, lower-case);
  // null for a variant without attributes. See combinationKey().
  @Column({ type: 'varchar', length: 1000, nullable: true })
  combinationKey: string | null;

  @Column({
    type: 'enum',
    enum: VariantStatus,
    default: VariantStatus.ACTIVE,
    nullable: false,
  })
  status: VariantStatus;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => Product, (product) => product.variants, {
    onDelete: 'CASCADE',
  })
  @JoinColumn([
    { name: 'productId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  product: Product;

  @OneToMany(() => AttributeValue, (value) => value.variant)
  attributeValues: AttributeValue[];

  // Every barcode of the variant, including the primary one
  @OneToMany(() => ProductBarcode, (barcode) => barcode.variant)
  barcodes: ProductBarcode[];
}
