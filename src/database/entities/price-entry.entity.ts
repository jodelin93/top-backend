import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { PriceList } from './price-list.entity';
import { ProductVariant } from './product-variant.entity';

@Entity('price_entries')
@Unique('uq_price_variant', ['priceListId', 'variantId'])
@Index(['tenantId'])
@Index(['priceListId'])
@Index(['variantId'])
export class PriceEntry extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  priceListId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  price: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  compareAtPrice: number;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: true })
  cost: number;

  @Column({ type: 'int', nullable: true })
  minQuantity: number;

  @Column({ type: 'int', nullable: true })
  maxQuantity: number;

  @Column({ type: 'timestamptz', nullable: true })
  validFrom: Date;

  @Column({ type: 'timestamptz', nullable: true })
  validTo: Date;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => PriceList, (priceList) => priceList.entries, {
    onDelete: 'CASCADE',
  })
  @JoinColumn([
    { name: 'priceListId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  priceList: PriceList;

  @ManyToOne(() => ProductVariant, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'variantId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  variant: ProductVariant;
}
