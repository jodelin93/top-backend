import { mergeStoreCredit } from '../stored-value/stored-value.service';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, EntityManager, In } from 'typeorm';
import { Customer, CustomerStatus } from '../database/entities/customer.entity';
import { CustomerConsentEvent } from '../database/entities/customer-consent-event.entity';
import { AuditService } from '../audit/audit.service';
import { requestContext } from '../common/context/request-context';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { MergeChoices, resolveMergedCustomer } from './customer-merge';
import { changedFieldNames } from './audit-safe';

export interface MergeResult {
  survivor: Customer;
  merged: Customer;
  // Rows moved to the survivor, per table (e.g. { sales: 12 })
  moved: Record<string, number>;
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

/**
 * Merges a duplicate customer into another in one transaction: references
 * (sales and any other table with a customerId) move to the survivor, points and
 * balances are added up, the consent history is kept, and the duplicate is
 * retired (inactive, mergedIntoId). Audited with ids and changed field names.
 */
@Injectable()
export class CustomerMergeService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {}

  async merge(
    tenantId: string,
    survivorId: string,
    mergedId: string,
    choices: MergeChoices = {},
  ): Promise<MergeResult> {
    if (survivorId === mergedId) {
      throw new BadRequestException('Choose two different customers');
    }
    try {
      return await this.dataSource.transaction((manager) =>
        this.mergeInTransaction(
          manager,
          tenantId,
          survivorId,
          mergedId,
          choices,
        ),
      );
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException(
          'These customers could not be merged automatically because both have a record that can only exist once per customer',
        );
      }
      throw error;
    }
  }

  private async mergeInTransaction(
    manager: EntityManager,
    tenantId: string,
    survivorId: string,
    mergedId: string,
    choices: MergeChoices,
  ): Promise<MergeResult> {
    const repo = manager.getRepository(Customer);
    // Lock both rows (in a fixed order, so concurrent merges can't deadlock)
    const locked = await repo
      .createQueryBuilder('customer')
      .where('customer.tenantId = :tenantId AND customer.id IN (:...ids)', {
        tenantId,
        ids: [survivorId, mergedId],
      })
      .orderBy('customer.id')
      .setLock('pessimistic_write')
      .getMany();
    const survivor = locked.find((c) => c.id === survivorId);
    const merged = locked.find((c) => c.id === mergedId);
    if (!survivor || !merged) {
      throw new NotFoundException('Customer not found');
    }
    if (survivor.mergedIntoId || merged.mergedIntoId) {
      throw new BadRequestException(
        'One of these customers has already been merged into another',
      );
    }
    const before = { survivor: { ...survivor }, merged: { ...merged } };

    const resolved = resolveMergedCustomer(survivor, merged, choices);
    // Two active store credit accounts can't both point at the survivor
    await mergeStoreCredit(manager, tenantId, mergedId, survivorId);
    const moved = await this.moveReferences(
      manager,
      tenantId,
      mergedId,
      survivorId,
    );

    // Records merged into the duplicate earlier now point at the survivor
    await repo.update(
      { tenantId, mergedIntoId: mergedId },
      { mergedIntoId: survivorId },
    );
    await repo.update(
      { id: survivorId, tenantId },
      resolved as Partial<Customer>,
    );
    await repo.update(
      { id: mergedId, tenantId },
      {
        status: CustomerStatus.INACTIVE,
        mergedIntoId: survivorId,
        loyaltyPoints: 0,
        currentBalance: 0,
      },
    );

    // The consent history moved along; note the resulting decision if it changed
    const events = manager.getRepository(CustomerConsentEvent);
    const recordedById = requestContext.get()?.userId ?? null;
    for (const [channel, field] of [
      ['email', 'marketingEmailConsent'],
      ['sms', 'marketingSmsConsent'],
    ] as const) {
      if (resolved[field] !== survivor[field]) {
        await events.save(
          events.create({
            tenantId,
            customerId: survivorId,
            channel,
            granted: !!resolved[field],
            source: 'merge',
            note: `Kept from merged customer ${merged.code}`,
            recordedById,
          }),
        );
      }
    }

    const [survivorAfter, mergedAfter] = await Promise.all([
      repo.findOneOrFail({ where: { id: survivorId, tenantId } }),
      repo.findOneOrFail({ where: { id: mergedId, tenantId } }),
    ]);
    await this.auditService.record(
      {
        tenantId,
        action: 'customer.merged',
        entityType: 'customer',
        entityId: survivorId,
        // Ids and field names only: audit rows can't be erased (no personal data)
        changes: {
          survivorChangedFields: changedFieldNames(
            before.survivor,
            survivorAfter,
          ),
          mergedChangedFields: changedFieldNames(before.merged, mergedAfter),
        },
        metadata: { mergedId, survivorId, moved, choices },
      },
      manager,
    );
    return { survivor: survivorAfter, merged: mergedAfter, moved };
  }

  /** Re-point every tenant table with a customerId column */
  private async moveReferences(
    manager: EntityManager,
    tenantId: string,
    fromId: string,
    toId: string,
  ): Promise<Record<string, number>> {
    const tables = await manager.query<{ table_name: string }[]>(
      `SELECT c.table_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
       WHERE c.table_schema = current_schema() AND c.column_name = 'customerId'
         AND c.table_name <> 'customers'
         AND EXISTS (SELECT 1 FROM information_schema.columns x
                     WHERE x.table_schema = c.table_schema AND x.table_name = c.table_name
                       AND x.column_name = 'tenantId')
       ORDER BY c.table_name`,
    );
    const moved: Record<string, number> = {};
    for (const { table_name: table } of tables) {
      if (!IDENTIFIER.test(table)) continue;
      const result: unknown = await manager.query(
        `UPDATE "${table}" SET "customerId" = $1 WHERE "customerId" = $2 AND "tenantId" = $3`,
        [toId, fromId, tenantId],
      );
      const count =
        Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
      if (count > 0) moved[table] = count;
    }
    return moved;
  }

  /** Customers merged into the given one (for the detail view) */
  mergedInto(tenantId: string, customerId: string): Promise<Customer[]> {
    return this.dataSource.getRepository(Customer).find({
      where: { tenantId, mergedIntoId: In([customerId]) },
      order: { updatedAt: 'DESC' },
    });
  }
}
