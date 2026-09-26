import { Entity, Column, Index, ManyToOne, JoinColumn } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { ProductVariant } from './product-variant.entity';
import { InventoryLocation } from './inventory-location.entity';
import { User } from './user.entity';

export enum MovementType {
  SALE = 'sale',
  PURCHASE = 'purchase',
  ADJUSTMENT = 'adjustment',
  TRANSFER = 'transfer',
  RETURN = 'return',
  DAMAGE = 'damage',
  THEFT = 'theft',
  RECOUNT = 'recount',
  // Zero-quantity valuation entry: a unit cost change (manual revaluation or a
  // costing method migration); before/after costs are in metadata
  REVALUATION = 'revaluation',
}

@Entity('stock_movements')
@Index(['tenantId'])
@Index(['variantId'])
@Index(['fromLocationId'])
@Index(['toLocationId'])
@Index(['movementType'])
@Index(['movementDate'])
@Index(['referenceType', 'referenceId'])
// One ledger row per business event: a duplicate posting of the same event is
// detected (and treated as already applied) instead of moving stock twice.
// Nullable for historical rows posted before the key existed.
@Index('uq_stock_movements_source_event', ['tenantId', 'sourceEventId'], {
  unique: true,
  where: '"sourceEventId" IS NOT NULL',
})
export class StockMovement extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'uuid', nullable: true })
  fromLocationId: string;

  @Column({ type: 'uuid', nullable: true })
  toLocationId: string;

  @Column({
    type: 'enum',
    enum: MovementType,
    nullable: false,
  })
  movementType: MovementType;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  quantity: number;

  @Column({
    type: 'timestamptz',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  movementDate: Date;

  @Column({ type: 'varchar', length: 50, nullable: true })
  referenceType: string;

  @Column({ type: 'uuid', nullable: true })
  referenceId: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  referenceNumber: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  cost: number;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  notes: string;

  @Column({ type: 'jsonb', default: {}, nullable: false })
  metadata: Record<string, any>;

  // Identity of the business event that posted the row, e.g.
  // "sale:<saleId>:<variantId>:<locationId>:sale" or "stock_transfer:<id>:<eventId>:<itemId>:out"
  @Column({ type: 'varchar', length: 200, nullable: true })
  sourceEventId: string | null;

  // Request that posted it (X-Request-Id), to group the rows of one action
  @Column({ type: 'varchar', length: 100, nullable: true })
  correlationId: string | null;

  // The movement this one reverses (the ledger is append-only: corrections are new rows)
  @Column({ type: 'uuid', nullable: true })
  reversalOfId: string | null;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => ProductVariant, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'variantId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  variant: ProductVariant;

  @ManyToOne(() => InventoryLocation, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'fromLocationId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  fromLocation: InventoryLocation;

  @ManyToOne(() => InventoryLocation, { onDelete: 'RESTRICT' })
  @JoinColumn([
    { name: 'toLocationId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  toLocation: InventoryLocation;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'userId' })
  user: User;
}
