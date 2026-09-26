import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';

/**
 * Unit of measure a product is stocked and sold in (piece, kg, litre, metre…).
 * allowsDecimals makes its products measured items: quantities with up to
 * `precision` decimals everywhere (sales, returns, stock, purchasing).
 */
@Entity('units')
@Unique('uq_units_code', ['tenantId', 'code'])
@Unique('uq_units_id_tenant', ['id', 'tenantId'])
@Index('idx_units_tenant', ['tenantId'])
export class ProductUnit extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  // Short code printed next to quantities: pc, kg, l, m
  @Column({ type: 'varchar', length: 20, nullable: false })
  code: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  // Whether quantities can have decimals (kg: yes, piece: no)
  @Column({ type: 'boolean', default: false, nullable: false })
  allowsDecimals: boolean;

  // Decimal places when allowsDecimals (0–4)
  @Column({ type: 'smallint', default: 0, nullable: false })
  precision: number;

  @Column({ type: 'boolean', default: true, nullable: false })
  isActive: boolean;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId', foreignKeyConstraintName: 'fk_units_tenant' })
  tenant: Tenant;
}
