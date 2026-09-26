import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntityWithVersion } from './base.entity';
import { Tenant } from './tenant.entity';
import { Register } from './register.entity';

export enum DrawerStatus {
  ACTIVE = 'active',
  INACTIVE = 'inactive',
}

/**
 * A cash drawer of a register. Shifts are counted per drawer: a register with one
 * drawer (the default, created with the register) behaves as before; a register
 * with two drawers can run two shifts at once. Whether cashiers share a drawer's
 * shift is the register's drawerPolicy.
 */
@Entity('drawers')
@Index('uq_drawer_code', ['tenantId', 'registerId', 'code'], { unique: true })
@Index('IDX_drawers_register', ['tenantId', 'registerId'])
@Check('CHK_drawers_status', `"status" IN ('active', 'inactive')`)
export class Drawer extends BaseEntityWithVersion {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  registerId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'varchar', length: 100, nullable: false })
  name: string;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: false,
    default: DrawerStatus.ACTIVE,
  })
  status: DrawerStatus;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'FK_drawers_tenant',
  })
  tenant?: Tenant;

  @ManyToOne(() => Register, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'registerId',
    foreignKeyConstraintName: 'FK_drawers_register',
  })
  register?: Register;
}
