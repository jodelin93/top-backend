import { Entity, Column, Index, ManyToOne, JoinColumn, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';

export enum TaxRateType {
  PERCENTAGE = 'percentage',
  FIXED_AMOUNT = 'fixed_amount',
}

export enum TaxRateStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

@Entity('tax_rates')
@Unique('uq_tax_code', ['tenantId', 'code'])
@Index(['tenantId'])
@Index(['countryCode'])
export class TaxRate extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'jsonb', nullable: false })
  name: Record<string, string>;

  @Column({
    type: 'enum',
    enum: TaxRateType,
    default: TaxRateType.PERCENTAGE,
    nullable: false,
  })
  taxType: TaxRateType;

  @Column({ type: 'numeric', precision: 5, scale: 2, nullable: false })
  rate: number;

  @Column({ type: 'char', length: 2, nullable: true })
  countryCode: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  stateProvince: string;

  @Column({ type: 'boolean', default: false, nullable: false })
  isCompound: boolean;

  @Column({ type: 'boolean', default: true, nullable: false })
  isDefault: boolean;

  @Column({
    type: 'enum',
    enum: TaxRateStatus,
    default: TaxRateStatus.ACTIVE,
    nullable: false,
  })
  status: TaxRateStatus;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;
}
