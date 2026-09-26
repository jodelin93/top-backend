import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { ProductVariant } from './product-variant.entity';

/**
 * Every barcode a variant can be scanned by (e.g. manufacturer EAN plus an in-store code).
 * product_variants.barcode stays as the primary one and is also listed here.
 */
@Entity('product_barcodes')
@Unique('uq_product_barcode', ['tenantId', 'barcode'])
@Index('IDX_product_barcodes_variant', ['variantId'])
export class ProductBarcode extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  barcode: string;

  @Column({ type: 'boolean', default: false, nullable: false })
  isPrimary: boolean;

  @ManyToOne(() => ProductVariant, (variant) => variant.barcodes, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'variantId',
    foreignKeyConstraintName: 'FK_product_barcodes_variant',
  })
  variant: ProductVariant;
}
