import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { Tenant } from './tenant.entity';

export enum CustomerFieldType {
  TEXT = 'text',
  NUMBER = 'number',
  DATE = 'date',
  SELECT = 'select',
  BOOLEAN = 'boolean',
}

/**
 * A store-defined customer field (e.g. "Loyalty card number", "Preferred store").
 * Values are kept in customers.metadata under the field's key.
 */
@Entity('customer_field_definitions')
@Unique('uq_customer_field_key', ['tenantId', 'key'])
@Index('IDX_customer_field_definitions_tenant', ['tenantId'])
export class CustomerFieldDefinition {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_customer_field_definitions',
  })
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  // Key in customers.metadata, e.g. "loyalty_card"
  @Column({ type: 'varchar', length: 50, nullable: false })
  key: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  label: string;

  @Column({
    type: 'enum',
    enum: CustomerFieldType,
    default: CustomerFieldType.TEXT,
    nullable: false,
  })
  fieldType: CustomerFieldType;

  @Column({ type: 'boolean', default: false, nullable: false })
  isRequired: boolean;

  // Choices of a select field
  @Column({ type: 'jsonb', nullable: true })
  options: string[] | null;

  @Column({ type: 'int', default: 0, nullable: false })
  sortOrder: number;

  @Column({ type: 'boolean', default: true, nullable: false })
  isActive: boolean;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_customer_field_definitions_tenant',
  })
  tenant: Tenant;
}
