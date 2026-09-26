import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { Product } from './product.entity';
import { Branch } from './branch.entity';

/**
 * Branch assortment: a product with rows here is only sold at those branches;
 * a product without any row is sold everywhere.
 */
@Entity('product_branches')
@Unique('uq_product_branches', ['productId', 'branchId'])
@Index('idx_product_branches_tenant_branch', ['tenantId', 'branchId'])
export class ProductBranch extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  productId: string;

  @Column({ type: 'uuid', nullable: false })
  branchId: string;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_product_branches_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => Product, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'productId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_product_branches_product',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  product: Product;

  @ManyToOne(() => Branch, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'branchId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_product_branches_branch',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  branch: Branch;
}
