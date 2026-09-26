import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Product } from './product.entity';

@Entity('product_images')
@Index(['tenantId'])
@Index(['productId'])
export class ProductImage extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  productId: string;

  @Column({ type: 'varchar', length: 500, nullable: false })
  url: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  altText: string | null;

  @Column({ type: 'int', default: 0, nullable: false })
  sortOrder: number;

  @Column({ type: 'boolean', default: false, nullable: false })
  isPrimary: boolean;

  // Object key in storage (null for images linked by external URL)
  @Column({ type: 'varchar', length: 300, nullable: true })
  storageKey: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  contentType: string | null;

  @Column({ type: 'int', nullable: true })
  sizeBytes: number | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'productId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  product: Product;
}
