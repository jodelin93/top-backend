import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Customer, CustomerStatus } from '../database/entities/customer.entity';
import { CustomerAddress } from '../database/entities/customer-address.entity';
import { CustomerContact } from '../database/entities/customer-contact.entity';
import { CustomerNote } from '../database/entities/customer-note.entity';
import { CustomerConsentEvent } from '../database/entities/customer-consent-event.entity';
import { StoredValueAccount } from '../database/entities/stored-value-account.entity';
import { AuditService } from '../audit/audit.service';
import { requestContext } from '../common/context/request-context';

export const ANONYMISED_NAME = 'Anonymised customer';
export const REMOVED_NOTE = '[removed]';

export interface AnonymiseResult {
  id: string;
  anonymisedAt: string;
}

/**
 * Money still owed either way blocks anonymisation: the account balance and
 * every stored-value account (store credit, gift cards) of the customer must be zero.
 */
export function assertNothingOwed(
  currentBalance: number | string,
  storedValueBalances: (number | string)[],
) {
  if (Number(currentBalance) !== 0) {
    throw new ConflictException(
      'Settle the customer account balance before anonymising this customer',
    );
  }
  if (storedValueBalances.some((b) => Number(b) !== 0)) {
    throw new ConflictException(
      'Use up or refund the customer’s store credit and gift cards before anonymising this customer',
    );
  }
}

/** The columns that replace a customer's personal data (id and sale links stay) */
export function anonymisedCustomerPatch(now: Date): Record<string, unknown> {
  return {
    firstName: null,
    lastName: null,
    companyName: ANONYMISED_NAME,
    email: null,
    phone: null,
    taxNumber: null,
    dateOfBirth: null,
    // Custom fields and addresses kept in metadata go too
    metadata: { anonymisedAt: now.toISOString() },
    marketingEmailConsent: false,
    marketingSmsConsent: false,
    consentUpdatedAt: now,
    consentSource: 'anonymisation',
    status: CustomerStatus.INACTIVE,
  };
}

/**
 * Right to erasure: removes a customer's personal data in one transaction while
 * keeping the record (id, code, sales, ledgers) so the books stay intact.
 * Addresses and contacts are deleted, note bodies replaced, consent withdrawn.
 * Audited with the id only.
 */
@Injectable()
export class CustomerAnonymizeService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {}

  anonymize(tenantId: string, customerId: string): Promise<AnonymiseResult> {
    return this.dataSource.transaction((manager) =>
      this.anonymizeInTransaction(manager, tenantId, customerId),
    );
  }

  private async anonymizeInTransaction(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
  ): Promise<AnonymiseResult> {
    const repo = manager.getRepository(Customer);
    // Locked, so no charge or payment can land between the check and the update
    const customer = await repo
      .createQueryBuilder('customer')
      .where('customer.id = :customerId AND customer.tenantId = :tenantId', {
        customerId,
        tenantId,
      })
      .setLock('pessimistic_write')
      .getOne();
    if (!customer) throw new NotFoundException('Customer not found');

    const accounts = await manager
      .getRepository(StoredValueAccount)
      .createQueryBuilder('account')
      .select(['account.id', 'account.balance'])
      .where(
        'account.tenantId = :tenantId AND account.customerId = :customerId',
        { tenantId, customerId },
      )
      .setLock('pessimistic_write')
      .getMany();
    assertNothingOwed(
      customer.currentBalance,
      accounts.map((a) => a.balance),
    );

    const now = new Date();
    await repo.update(
      { id: customerId, tenantId },
      anonymisedCustomerPatch(now),
    );
    await manager.delete(CustomerAddress, { tenantId, customerId });
    await manager.delete(CustomerContact, { tenantId, customerId });
    await manager.update(
      CustomerNote,
      { tenantId, customerId },
      { body: REMOVED_NOTE },
    );
    // Estimates keep a free-text name for walk-ins; drop it for this customer
    await manager.query(
      `UPDATE estimates SET "customerName" = NULL
        WHERE "tenantId" = $1 AND "customerId" = $2 AND "customerName" IS NOT NULL`,
      [tenantId, customerId],
    );

    // The consent history is append-only: record the withdrawal
    const events = manager.getRepository(CustomerConsentEvent);
    const recordedById = requestContext.get()?.userId ?? null;
    const withdrawn = (
      [
        ['email', customer.marketingEmailConsent],
        ['sms', customer.marketingSmsConsent],
      ] as const
    ).filter(([, granted]) => granted);
    if (withdrawn.length) {
      await events.save(
        withdrawn.map(([channel]) =>
          events.create({
            tenantId,
            customerId,
            channel,
            granted: false,
            source: 'anonymisation',
            recordedById,
          }),
        ),
      );
    }

    await this.auditService.record(
      {
        tenantId,
        action: 'customer.anonymised',
        entityType: 'customer',
        entityId: customerId,
      },
      manager,
    );
    return { id: customerId, anonymisedAt: now.toISOString() };
  }
}
