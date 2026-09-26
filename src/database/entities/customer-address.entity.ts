import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Customer } from './customer.entity';

export enum CustomerAddressType {
  BILLING = 'billing',
  SHIPPING = 'shipping',
}

/** Billing / shipping addresses of a customer; one default per type */
@Entity('customer_addresses')
@Index('IDX_customer_addresses_customer', ['tenantId', 'customerId'])
@Index(
  'uq_customer_address_default',
  ['tenantId', 'customerId', 'addressType'],
  {
    unique: true,
    where: '"isDefault" = true',
  },
)
export class CustomerAddress extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  customerId: string;

  @Column({
    type: 'enum',
    enum: CustomerAddressType,
    enumName: 'customer_addresses_type_enum',
    nullable: false,
  })
  addressType: CustomerAddressType;

  // e.g. "Head office", "Warehouse"
  @Column({ type: 'varchar', length: 100, nullable: true })
  label: string | null;

  @Column({ type: 'varchar', length: 255, nullable: false })
  line1: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  line2: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  state: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  postalCode: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  country: string | null;

  @Column({ type: 'boolean', default: false, nullable: false })
  isDefault: boolean;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'customerId',
    foreignKeyConstraintName: 'FK_customer_addresses_customer',
  })
  customer?: Customer;
}
