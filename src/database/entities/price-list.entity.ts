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
import { Branch } from './branch.entity';
import { PriceEntry } from './price-entry.entity';

export enum PriceListType {
  STANDARD = 'standard',
  PROMOTIONAL = 'promotional',
  WHOLESALE = 'wholesale',
  MEMBER = 'member',
}

export enum PriceListStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
  SCHEDULED = 'scheduled',
}

@Entity('price_lists')
@Unique('uq_pricelist_code', ['tenantId', 'code'])
@Unique('uq_pricelist_id_tenant', ['id', 'tenantId'])
@Index(['tenantId'])
@Index(['branchId'])
export class PriceList extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'jsonb', nullable: false })
  name: Record<string, string>;

  @Column({ type: 'jsonb', nullable: true })
  description: Record<string, string>;

  @Column({
    type: 'enum',
    enum: PriceListType,
    default: PriceListType.STANDARD,
    nullable: false,
  })
  priceListType: PriceListType;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  @Column({ type: 'uuid', nullable: true })
  branchId: string;

  @Column({ type: 'timestamptz', nullable: true })
  validFrom: Date;

  @Column({ type: 'timestamptz', nullable: true })
  validTo: Date;

  @Column({ type: 'int', default: 0, nullable: false })
  priority: number;

  @Column({
    type: 'enum',
    enum: PriceListStatus,
    default: PriceListStatus.ACTIVE,
    nullable: false,
  })
  status: PriceListStatus;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @ManyToOne(() => Branch, { onDelete: 'CASCADE' })
  @JoinColumn([
    { name: 'branchId', referencedColumnName: 'id' },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  branch: Branch;

  @OneToMany(() => PriceEntry, (entry) => entry.priceList)
  entries: PriceEntry[];
}
