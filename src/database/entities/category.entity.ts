import {
  Entity,
  Column,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
  Tree,
  TreeChildren,
  TreeParent,
} from 'typeorm';
import { BaseEntityWithVersion } from './base.entity';
import { Tenant } from './tenant.entity';

@Entity('categories')
@Unique('uq_category_code', ['tenantId', 'code'])
@Unique('uq_category_id_tenant', ['id', 'tenantId'])
@Index(['tenantId'])
@Tree('materialized-path')
// version: optimistic concurrency for admin edits (If-Match)
export class Category extends BaseEntityWithVersion {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 50, nullable: false })
  code: string;

  @Column({ type: 'jsonb', nullable: false })
  name: Record<string, string>; // { en: 'Electronics', fr: 'Électronique' }

  @Column({ type: 'jsonb', nullable: true })
  description: Record<string, string>;

  @Column({ type: 'uuid', nullable: true })
  parentId: string;

  @Column({ type: 'int', default: 0, nullable: false })
  sortOrder: number;

  @Column({ type: 'boolean', default: true, nullable: false })
  isActive: boolean;

  @Column({ type: 'varchar', length: 255, nullable: true })
  imageUrl: string;

  // Relations
  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tenantId' })
  tenant: Tenant;

  @TreeParent()
  parent: Category;

  @TreeChildren()
  children: Category[];
}
