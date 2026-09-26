import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
  OneToMany,
} from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';
import { AttributeValue } from './attribute-value.entity';

export enum AttributeType {
  TEXT = 'text',
  NUMBER = 'number',
  BOOLEAN = 'boolean',
  SELECT = 'select',
  MULTISELECT = 'multiselect',
  COLOR = 'color',
}

@Entity('attribute_definitions')
@Unique('uq_attribute_code', ['tenantId', 'code'])
@Unique('uq_attribute_id_tenant', ['id', 'tenantId'])
@Index(['tenantId'])
export class AttributeDefinition extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'jsonb', nullable: false })
  name: Record<string, string>;

  @Column({
    type: 'enum',
    enum: AttributeType,
    nullable: false,
  })
  attributeType: AttributeType;

  @Column({ type: 'jsonb', nullable: true })
  options: string[] | null; // For select/multiselect types

  @Column({ type: 'boolean', default: false, nullable: false })
  isRequired: boolean;

  @Column({ type: 'boolean', default: false, nullable: false })
  isVariantDefining: boolean; // Used for product variant generation

  @Column({ type: 'int', default: 0, nullable: false })
  sortOrder: number;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @OneToMany(() => AttributeValue, (value) => value.attribute)
  values: AttributeValue[];
}
