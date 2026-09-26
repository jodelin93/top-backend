import { Column, Entity, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';

// A store's own list of notes/coins for a currency (overrides the built-in defaults)
@Entity('cash_denomination_sets')
@Unique('uq_cash_denomination_set', ['tenantId', 'currencyCode'])
export class CashDenominationSet extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  // Face values, largest first, e.g. [100, 50, 20, 10, 5, 1, 0.25]
  @Column({ type: 'jsonb', nullable: false })
  denominations: number[];

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_cash_denomination_sets_tenant',
  })
  tenant: Tenant;
}
