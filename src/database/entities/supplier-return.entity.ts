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
import { Supplier } from './supplier.entity';
import { GoodsReceipt } from './goods-receipt.entity';
import { InventoryLocation } from './inventory-location.entity';
import { User } from './user.entity';
import { SupplierReturnItem } from './supplier-return-item.entity';

/**
 * Goods sent back to a supplier from a receipt: removes the units from stock
 * and creates a supplier credit for their value.
 */
@Entity('supplier_returns')
@Unique('uq_supplier_returns_number', ['tenantId', 'returnNumber'])
@Unique('uq_supplier_returns_id_tenant', ['id', 'tenantId'])
@Index('idx_supplier_returns_supplier', ['tenantId', 'supplierId'])
@Index('idx_supplier_returns_receipt', ['receiptId'])
export class SupplierReturn extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  // SR-000001
  @Column({ type: 'varchar', length: 50, nullable: false })
  returnNumber: string;

  @Column({ type: 'uuid', nullable: false })
  supplierId: string;

  @Column({ type: 'uuid', nullable: false })
  receiptId: string;

  // Where the units leave from (the receipt's location)
  @Column({ type: 'uuid', nullable: false })
  locationId: string;

  @Column({ type: 'varchar', length: 500, nullable: false })
  reason: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  reference: string | null;

  @Column({ type: 'numeric', precision: 19, scale: 4, nullable: false })
  totalAmount: number;

  @Column({ type: 'char', length: 3, nullable: false })
  currencyCode: string;

  @Column({ type: 'uuid', nullable: false })
  userId: string;

  @Column({
    type: 'timestamptz',
    nullable: false,
    default: () => 'CURRENT_TIMESTAMP',
  })
  returnedAt: Date;

  @ManyToOne(() => Tenant, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'tenantId',
    foreignKeyConstraintName: 'fk_supplier_returns_tenant',
  })
  tenant: Tenant;

  @ManyToOne(() => Supplier, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'supplierId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_returns_supplier',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  supplier: Supplier;

  @ManyToOne(() => GoodsReceipt, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'receiptId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_returns_receipt',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  receipt: GoodsReceipt;

  @ManyToOne(() => InventoryLocation, { onDelete: 'RESTRICT' })
  @JoinColumn([
    {
      name: 'locationId',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_supplier_returns_location',
    },
    { name: 'tenantId', referencedColumnName: 'tenantId' },
  ])
  location: InventoryLocation;

  @ManyToOne(() => User, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'userId',
    foreignKeyConstraintName: 'fk_supplier_returns_user',
  })
  user: User;

  @OneToMany(() => SupplierReturnItem, (item) => item.supplierReturn)
  items: SupplierReturnItem[];
}
