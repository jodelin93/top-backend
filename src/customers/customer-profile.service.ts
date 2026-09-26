import { Injectable, NotFoundException } from '@nestjs/common';
import { branchScope, scopedBranchIds } from '../auth/branch-scope';
import { DataSource, EntityManager } from 'typeorm';
import { Customer } from '../database/entities/customer.entity';
import { CustomerAddress } from '../database/entities/customer-address.entity';
import { CustomerContact } from '../database/entities/customer-contact.entity';
import {
  CustomerNote,
  CustomerNoteVisibility,
} from '../database/entities/customer-note.entity';
import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { AuditService } from '../audit/audit.service';
import {
  CreateCustomerAddressDto,
  CreateCustomerContactDto,
  CreateCustomerNoteDto,
  UpdateCustomerAddressDto,
  UpdateCustomerContactDto,
} from './customer-profile.dto';

/** Who may read "managers" notes */
export const canSeeManagerNotes = (permissions?: readonly string[] | null) =>
  !!permissions?.includes('customers.manage');

/** Notes a user may see (restricted notes only for customers.manage) */
export function visibleNotes<T extends Pick<CustomerNote, 'visibility'>>(
  notes: T[],
  permissions?: readonly string[] | null,
): T[] {
  return canSeeManagerNotes(permissions)
    ? notes
    : notes.filter((n) => n.visibility !== CustomerNoteVisibility.MANAGERS);
}

export type ActivityKind =
  'sale' | 'return' | 'credit' | 'loyalty' | 'note' | 'store_credit';

export interface ActivityItem {
  kind: ActivityKind;
  id: string;
  date: Date;
  // English label (translated by the client), e.g. "charge", "completed"
  label: string;
  reference: string | null;
  amount: number | null;
  detail: string | null;
}

/**
 * Customer addresses, contacts, internal notes and the activity history
 * (spec §11). Every change is audited.
 */
@Injectable()
export class CustomerProfileService {
  constructor(
    private dataSource: DataSource,
    private auditService: AuditService,
  ) {}

  private async assertCustomer(tenantId: string, customerId: string) {
    const exists = await this.dataSource
      .getRepository(Customer)
      .exists({ where: { id: customerId, tenantId } });
    if (!exists) throw new NotFoundException('Customer not found');
  }

  // ---- Addresses ----

  async addresses(tenantId: string, customerId: string) {
    await this.assertCustomer(tenantId, customerId);
    return this.dataSource.getRepository(CustomerAddress).find({
      where: { tenantId, customerId },
      order: { addressType: 'ASC', isDefault: 'DESC', createdAt: 'ASC' },
    });
  }

  async addAddress(
    tenantId: string,
    customerId: string,
    dto: CreateCustomerAddressDto,
  ) {
    await this.assertCustomer(tenantId, customerId);
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CustomerAddress);
      const count = await repo.count({
        where: { tenantId, customerId, addressType: dto.addressType },
      });
      // The first address of a type is its default
      const isDefault = dto.isDefault ?? count === 0;
      if (isDefault) {
        await repo.update(
          {
            tenantId,
            customerId,
            addressType: dto.addressType,
            isDefault: true,
          },
          { isDefault: false },
        );
      }
      const address = await repo.save(
        repo.create({ ...dto, tenantId, customerId, isDefault }),
      );
      await this.audit(
        manager,
        tenantId,
        customerId,
        'customer.address_added',
        {
          addressId: address.id,
          addressType: address.addressType,
        },
      );
      return address;
    });
  }

  async updateAddress(
    tenantId: string,
    customerId: string,
    id: string,
    dto: UpdateCustomerAddressDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CustomerAddress);
      const address = await repo.findOne({
        where: { id, tenantId, customerId },
      });
      if (!address) throw new NotFoundException('Address not found');
      const next = { ...address, ...dto };
      if (dto.isDefault) {
        await repo.update(
          {
            tenantId,
            customerId,
            addressType: next.addressType,
            isDefault: true,
          },
          { isDefault: false },
        );
      }
      const patch = Object.fromEntries(
        Object.entries(dto).filter(([, v]) => v !== undefined),
      );
      await repo.update({ id, tenantId }, patch);
      await this.audit(
        manager,
        tenantId,
        customerId,
        'customer.address_updated',
        {
          addressId: id,
          // Field names only (addresses and contacts are personal data)
          changedFields: Object.keys(patch).sort(),
        },
      );
      return repo.findOneOrFail({ where: { id, tenantId } });
    });
  }

  async removeAddress(tenantId: string, customerId: string, id: string) {
    await this.dataSource.transaction(async (manager) => {
      const result = await manager.delete(CustomerAddress, {
        id,
        tenantId,
        customerId,
      });
      if (!result.affected) throw new NotFoundException('Address not found');
      await this.audit(
        manager,
        tenantId,
        customerId,
        'customer.address_removed',
        {
          addressId: id,
        },
      );
    });
  }

  // ---- Contacts ----

  async contacts(tenantId: string, customerId: string) {
    await this.assertCustomer(tenantId, customerId);
    return this.dataSource.getRepository(CustomerContact).find({
      where: { tenantId, customerId },
      order: { isPrimary: 'DESC', name: 'ASC' },
    });
  }

  async addContact(
    tenantId: string,
    customerId: string,
    dto: CreateCustomerContactDto,
  ) {
    await this.assertCustomer(tenantId, customerId);
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CustomerContact);
      if (dto.isPrimary) {
        await repo.update(
          { tenantId, customerId, isPrimary: true },
          { isPrimary: false },
        );
      }
      const contact = await repo.save(
        repo.create({ ...dto, tenantId, customerId }),
      );
      await this.audit(
        manager,
        tenantId,
        customerId,
        'customer.contact_added',
        {
          contactId: contact.id,
        },
      );
      return contact;
    });
  }

  async updateContact(
    tenantId: string,
    customerId: string,
    id: string,
    dto: UpdateCustomerContactDto,
  ) {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CustomerContact);
      const contact = await repo.findOne({
        where: { id, tenantId, customerId },
      });
      if (!contact) throw new NotFoundException('Contact not found');
      if (dto.isPrimary) {
        await repo.update(
          { tenantId, customerId, isPrimary: true },
          { isPrimary: false },
        );
      }
      const patch = Object.fromEntries(
        Object.entries(dto).filter(([, v]) => v !== undefined),
      );
      await repo.update({ id, tenantId }, patch);
      await this.audit(
        manager,
        tenantId,
        customerId,
        'customer.contact_updated',
        {
          contactId: id,
          // Field names only (addresses and contacts are personal data)
          changedFields: Object.keys(patch).sort(),
        },
      );
      return repo.findOneOrFail({ where: { id, tenantId } });
    });
  }

  async removeContact(tenantId: string, customerId: string, id: string) {
    await this.dataSource.transaction(async (manager) => {
      const result = await manager.delete(CustomerContact, {
        id,
        tenantId,
        customerId,
      });
      if (!result.affected) throw new NotFoundException('Contact not found');
      await this.audit(
        manager,
        tenantId,
        customerId,
        'customer.contact_removed',
        {
          contactId: id,
        },
      );
    });
  }

  // ---- Notes ----

  async notes(tenantId: string, customerId: string, user: AuthUser) {
    await this.assertCustomer(tenantId, customerId);
    const notes = await this.dataSource.getRepository(CustomerNote).find({
      where: { tenantId, customerId },
      order: { createdAt: 'DESC' },
      take: 200,
    });
    return visibleNotes(notes, user.permissions);
  }

  async addNote(
    tenantId: string,
    customerId: string,
    user: AuthUser,
    dto: CreateCustomerNoteDto,
  ) {
    await this.assertCustomer(tenantId, customerId);
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CustomerNote);
      const note = await repo.save(
        repo.create({
          tenantId,
          customerId,
          body: dto.body.trim(),
          visibility: dto.visibility ?? CustomerNoteVisibility.ALL,
          createdById: user.id,
        }),
      );
      await this.audit(manager, tenantId, customerId, 'customer.note_added', {
        noteId: note.id,
        visibility: note.visibility,
      });
      return note;
    });
  }

  async removeNote(tenantId: string, customerId: string, id: string) {
    await this.dataSource.transaction(async (manager) => {
      const note = await manager.findOne(CustomerNote, {
        where: { id, tenantId, customerId },
      });
      if (!note) throw new NotFoundException('Note not found');
      await manager.delete(CustomerNote, { id, tenantId });
      await this.audit(manager, tenantId, customerId, 'customer.note_removed', {
        noteId: id,
        visibility: note.visibility,
        // Not the body: audit rows can't be erased
        length: note.body.length,
      });
    });
  }

  // ---- Activity ----

  /**
   * Everything that happened with the customer, newest first: sales, returns,
   * account entries and store credit (customers.finance.view), loyalty points,
   * and notes (restricted ones only for customers.manage)
   */
  async activity(
    tenantId: string,
    customerId: string,
    user: AuthUser,
    limit = 100,
  ): Promise<ActivityItem[]> {
    await this.assertCustomer(tenantId, customerId);
    const take = Math.min(Math.max(limit, 1), 300);
    const finance = !!user.permissions?.includes('customers.finance.view');
    const q = <T>(sql: string) =>
      this.dataSource.query<T[]>(sql, [tenantId, customerId, take]);
    // Sales and returns: of the user's branches only ($4, NULL = all; spec §9)
    const scoped = <T>(sql: string) =>
      this.dataSource.query<T[]>(sql, [
        tenantId,
        customerId,
        take,
        scopedBranchIds(branchScope(user)),
      ]);

    const [sales, returns, loyalty, notes, credit, storeCredit] =
      await Promise.all([
        scoped<{
          id: string;
          date: Date;
          ref: string;
          amount: string;
          status: string;
        }>(
          `SELECT id, "saleDate" AS date, "saleNumber" AS ref, total AS amount, status
             FROM sales WHERE "tenantId" = $1 AND "customerId" = $2
              AND status NOT IN ('draft', 'held', 'cancelled')
              AND ($4::uuid[] IS NULL OR "branchId" = ANY($4::uuid[]))
            ORDER BY "saleDate" DESC LIMIT $3`,
        ),
        scoped<{
          id: string;
          date: Date;
          ref: string;
          amount: string;
          returnType: string;
          reason: string;
        }>(
          `SELECT id, created_at AS date, "returnNumber" AS ref, total AS amount, "returnType", reason
             FROM sale_returns r WHERE "tenantId" = $1 AND "customerId" = $2
              AND ($4::uuid[] IS NULL OR (SELECT s."branchId" FROM sales s WHERE s.id = r."originalSaleId") = ANY($4::uuid[]))
            ORDER BY created_at DESC LIMIT $3`,
        ),
        q<{
          id: string;
          date: Date;
          type: string;
          points: number;
          note: string | null;
        }>(
          `SELECT id, created_at AS date, type, points, note
             FROM loyalty_transactions WHERE "tenantId" = $1 AND "customerId" = $2
            ORDER BY created_at DESC LIMIT $3`,
        ),
        q<{
          id: string;
          date: Date;
          body: string;
          visibility: CustomerNoteVisibility;
        }>(
          `SELECT id, created_at AS date, body, visibility
             FROM customer_notes WHERE "tenantId" = $1 AND "customerId" = $2
            ORDER BY created_at DESC LIMIT $3`,
        ),
        finance
          ? q<{
              id: string;
              date: Date;
              type: string;
              amount: string;
              ref: string | null;
              note: string | null;
            }>(
              `SELECT id, created_at AS date, type, amount, "paymentRef" AS ref, note
                 FROM customer_credit_entries WHERE "tenantId" = $1 AND "customerId" = $2
                ORDER BY created_at DESC LIMIT $3`,
            )
          : Promise.resolve([]),
        finance
          ? q<{
              id: string;
              date: Date;
              type: string;
              amount: string;
              note: string | null;
            }>(
              `SELECT e.id, e.created_at AS date, e.type, e.amount, e.note
                 FROM stored_value_entries e
                 JOIN stored_value_accounts a ON a.id = e."accountId"
                WHERE a."tenantId" = $1 AND a."customerId" = $2
                ORDER BY e.created_at DESC LIMIT $3`,
            )
          : Promise.resolve([]),
      ]);

    const items: ActivityItem[] = [
      ...sales.map((s) => ({
        kind: 'sale' as const,
        id: s.id,
        date: new Date(s.date),
        label: s.status,
        reference: s.ref,
        amount: Number(s.amount),
        detail: null,
      })),
      ...returns.map((r) => ({
        kind: 'return' as const,
        id: r.id,
        date: new Date(r.date),
        label: r.returnType,
        reference: r.ref,
        amount: -Number(r.amount),
        detail: r.reason,
      })),
      ...loyalty.map((l) => ({
        kind: 'loyalty' as const,
        id: l.id,
        date: new Date(l.date),
        label: l.type,
        reference: null,
        amount: Number(l.points),
        detail: l.note,
      })),
      ...visibleNotes(notes, user.permissions).map((n) => ({
        kind: 'note' as const,
        id: n.id,
        date: new Date(n.date),
        label: n.visibility,
        reference: null,
        amount: null,
        detail: n.body,
      })),
      ...credit.map((c) => ({
        kind: 'credit' as const,
        id: c.id,
        date: new Date(c.date),
        label: c.type,
        reference: c.ref,
        amount: Number(c.amount),
        detail: c.note,
      })),
      ...storeCredit.map((e) => ({
        kind: 'store_credit' as const,
        id: e.id,
        date: new Date(e.date),
        label: e.type,
        reference: null,
        amount: Number(e.amount),
        detail: e.note,
      })),
    ];
    return items
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .slice(0, take);
  }

  private audit(
    manager: EntityManager,
    tenantId: string,
    customerId: string,
    action: string,
    metadata: Record<string, unknown>,
  ) {
    return this.auditService.record(
      {
        tenantId,
        action,
        entityType: 'customer',
        entityId: customerId,
        metadata,
      },
      manager,
    );
  }
}
