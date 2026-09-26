import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Sale } from './sale.entity';
import { ProductVariant } from './product-variant.entity';

@Entity('sale_items')
@Index(['tenantId'])
@Index(['saleId'])
@Index(['variantId'])
export class SaleItem extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  saleId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  sku: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  productName: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  variantName: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  quantity: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  unitPrice: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  subtotal: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  discountAmount: number;

  @Column({
    type: 'numeric',
    precision: 19,
    scale: 4,
    default: 0,
    nullable: false,
  })
  taxAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  total: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  cost: number;

  // Tax rate applied to this line (percent), resolved from the product's tax category
  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  taxRate: number | null;

  // Catalog price before a till price override; null when the price was not overridden
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  originalUnitPrice: number | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  notes: string;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  metadata: Record<string, any>;

  @Column({ type: 'int', default: 0, nullable: false })
  lineNumber: number;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => Sale, (sale) => sale.items, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'saleId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  sale: Sale;

  @ManyToOne(() => ProductVariant, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'variantId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  variant: ProductVariant;
}
