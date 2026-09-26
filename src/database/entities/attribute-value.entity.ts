import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { AttributeDefinition } from './attribute-definition.entity';
import { ProductVariant } from './product-variant.entity';

@Entity('attribute_values')
@Unique('uq_attribute_variant', ['variantId', 'attributeId'])
@Index(['tenantId'])
@Index(['variantId'])
@Index(['attributeId'])
export class AttributeValue extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  variantId: string;

  @Column({ type: 'uuid', nullable: false })
  attributeId: string;

  @Column({ type: 'text', nullable: false })
  value: string;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => ProductVariant, (variant) => variant.attributeValues, {
    onDelete: 'CASCADE',
  })
  @JoinColumn([
    { name: 'variantId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  variant: ProductVariant;

  @ManyToOne(() => AttributeDefinition, (attr) => attr.values, {
    onDelete: 'CASCADE',
  })
  @JoinColumn([
    { name: 'attributeId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  attribute: AttributeDefinition;
}
