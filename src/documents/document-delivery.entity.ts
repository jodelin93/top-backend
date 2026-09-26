import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';
import type { DocumentType } from './print-job.entity';

export type DeliveryChannel = 'email' | 'sms_link';
export type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'revoked';
// Why the store may e-mail this address: the customer's recorded consent, or the
// cashier confirmed the customer asked for this (transactional) e-mail
export type ConsentBasis = 'customer_consent' | 'cashier_confirmed';

/**
 * A document sent outside the till (spec §15): an e-mailed receipt, or a signed
 * read-only link to share by SMS / WhatsApp (no SMS gateway: the cashier copies or
 * shares the link). `recipient` is never written to logs unmasked.
 */
@Entity('document_deliveries')
@Index('IDX_document_deliveries_document', [
  'tenantId',
  'documentType',
  'documentId',
])
export class DocumentDelivery {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_document_deliveries',
  })
  id: string;

  @Column({ type: 'uuid', nullable: false })
  tenantId: string;

  @Column({ type: 'varchar', length: 20, nullable: false })
  documentType: DocumentType;

  @Column({ type: 'uuid', nullable: false })
  documentId: string;

  @Column({ type: 'varchar', length: 10, nullable: false })
  channel: DeliveryChannel;

  // E-mail address or phone number; null for a link shared without one
  @Column({ type: 'varchar', length: 255, nullable: true })
  recipient: string | null;

  @Column({ type: 'varchar', length: 10, nullable: false, default: 'queued' })
  status: DeliveryStatus;

  @Column({ type: 'text', nullable: true })
  error: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  consentBasis: ConsentBasis | null;

  // Shared links stop working after this
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  userId: string | null;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: false, default: () => 'now()' })
  updatedAt: Date;
}
