import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { BaseEntity } from './base.entity';
import { Customer } from './customer.entity';

/** People to reach at a (business) customer */
@Entity('customer_contacts')
@Index('IDX_customer_contacts_customer', ['tenantId', 'customerId'])
export class CustomerContact extends BaseEntity {
  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'uuid', nullable: false })
  customerId: string;

  @Column({ type: 'varchar', length: 255, nullable: false })
  name: string;

  // e.g. "Purchasing", "Accounts payable"
  @Column({ type: 'varchar', length: 100, nullable: true })
  role: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true })
  phone: string | null;

  @Column({ type: 'boolean', default: false, nullable: false })
  isPrimary: boolean;

  @ManyToOne(() => Customer, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'customerId',
    foreignKeyConstraintName: 'FK_customer_contacts_customer',
  })
  customer?: Customer;
}
