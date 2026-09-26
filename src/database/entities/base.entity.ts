import {
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

/**
 * Base entity with common fields for all entities
 */
export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}

/**
 * Base entity with optimistic locking support
 */
export abstract class BaseEntityWithVersion extends BaseEntity {
  @VersionColumn({ name: 'version', type: 'int', default: 1 })
  version: number;
}

/**
 * Base entity for tenant-scoped data
 * Inherits id, createdAt, updatedAt from BaseEntity
 */
export abstract class TenantBaseEntity extends BaseEntity {
  // tenantId will be defined in concrete entities that extend this
}
