import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';

@Entity('expense_categories')
@Unique('uq_expense_category_code', ['tenantId', 'code'])
@Unique('uq_expense_category_id_tenant', ['id', 'tenantId'])
@Index('IDX_expense_categories_tenant', ['tenantId'])
export class ExpenseCategory extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @Column({ type: 'boolean', default: true, nullable: false })
  isActive: boolean;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_expense_categories_tenant',
  })
  tenant: Tenant;
}
