import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { TaxRate } from './tax-rate.entity';

/**
 * Groups products that are taxed the same way (e.g. "Food", "Alcohol", "Exempt").
 * Products without a category use the store's default tax rate.
 */
@Entity('tax_categories')
@Unique('uq_tax_category_code', ['tenantId', 'code'])
@Index('IDX_tax_categories_tenant', ['tenantId'])
export class TaxCategory extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'jsonb', nullable: false })
  name: Record<string, string>;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  // Rate applied to products in this category; null means tax exempt
  @Column({ type: 'uuid', nullable: true })
  taxRateId: string | null;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_tax_categories_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => TaxRate, { onDelete: 'SET NULL' })
  @JoinColumn({
    name: 'taxRateId',
    foreignKeyConstraintName: 'FK_tax_categories_rate',
  })
  taxRate: TaxRate | null;
}
