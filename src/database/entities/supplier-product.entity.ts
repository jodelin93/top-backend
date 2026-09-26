import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Supplier } from './supplier.entity';
import { ProductVariant } from './product-variant.entity';

/**
 * What a supplier sells: their code for a variant, the last price paid and the
 * minimum order quantity. Prefills purchase order lines and groups reorder
 * suggestions (the preferred supplier of a variant).
 */
@Entity('supplier_products')
@Unique('uq_supplier_products_variant', ['tenantId', 'supplierId', 'variantId'])
@Index('idx_supplier_products_variant', ['tenantId', 'variantId'])
export class SupplierProduct extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  supplierId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  supplierSku: string | null;

  // Unit cost of the last receipt from this supplier (or entered by hand)
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  lastCost: number | null;

  @Column({ type: 'int', nullable: true })
  minOrderQty: number | null;

  // Supplier used for reorder suggestions of this variant
  @Column({ type: 'boolean', default: false, nullable: false })
  isPreferred: boolean;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_supplier_products_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => Supplier, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'supplierId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_products_supplier',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  supplier: Supplier;

  @ManyToOne(() => ProductVariant, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'variantId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_products_variant',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  variant: ProductVariant;
}
