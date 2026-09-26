import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Estimate } from './estimate.entity';

@Entity('estimate_items')
@Index('IDX_estimate_items_estimate', ['estimateId'])
export class EstimateItem extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  estimateId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  sku: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  productName: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  variantName: string | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  quantity: number;

  // Quoted price (the catalog price, or a negotiated one)
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  unitPrice: number;

  // Catalog price when the estimate was written, to show the saving
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  catalogPrice: number;

  @Column({
    type: 'numeric',
    precision: 5,
    scale: 2,
    default: 0,
    nullable: false,
  })
  discountPercent: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  subtotal: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  discountAmount: number;

  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: true })
  taxRate: number | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  taxAmount: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  total: number;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note: string | null;

  @Column({ type: 'int', default: 0, nullable: false })
  lineNumber: number;

  @ManyToOne(() => Estimate, (estimate) => estimate.items, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'estimateId',
    foreignKeyConstraintName: 'FK_estimate_items_estimate',
  })
  estimate: Estimate;
}
