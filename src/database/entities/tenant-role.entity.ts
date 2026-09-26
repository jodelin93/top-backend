import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Tenant } from './tenant.entity';

@Entity('tenant_roles')
@Unique('uq_tenant_role_key', ['tenantId', 'key'])
@Index('IDX_tenant_roles_tenant', ['tenantId'])
export class TenantRole extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  // Stable identifier stored on memberships (e.g. 'cashier', 'shift-lead')
  @Column({ type: 'varchar', length: 50, nullable: false })
  key: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  @Column({ type: 'jsonb', default: [], nullable: false })
  permissions: string[];

  // Built-in roles can be edited (except owner) but not deleted
  @Column({ type: 'boolean', default: false, nullable: false })
  isSystem: boolean;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_tenant_roles_tenant',
  })
  tenant: Tenant;
}
