import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { StockCount } from './stock-count.entity';
import { ProductVariant } from './product-variant.entity';

@Entity('stock_count_items')
@Unique('uq_stock_count_items_variant', ['countId', 'variantId'])
@Index('idx_stock_count_items_tenant', ['tenantId'])
export class StockCountItem extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  countId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  // On-hand quantity when the session started
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  expectedQuantity: number;

  // Null = not counted yet (uncounted lines are not adjusted)
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  countedQuantity: number | null;

  // Net movements at the location between the snapshot and countedAt (sales,
  // receipts… while counting), set at submission / approval
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  movementsSinceSnapshot: number | null;

  // counted − (expected + movementsSinceSnapshot), set when the count is submitted
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  variance: number | null;

  // Why the counted quantity differs (optional, per line)
  @Column({ type: 'varchar', length: 200, nullable: true })
  reason: string | null;

  // Unit cost at submission, to value the variance
  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  unitCost: number | null;

  @Column({ type: 'timestamptz', nullable: true })
  countedAt: Date | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_stock_count_items_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => StockCount, (count) => count.items, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'countId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_stock_count_items_count',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  count: StockCount;

  @ManyToOne(() => ProductVariant, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'variantId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_stock_count_items_variant',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  variant: ProductVariant;
}
