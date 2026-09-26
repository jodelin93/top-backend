import {
  BadRequestException,
  ForbiddenException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, DeepPartial, EntityManager, Repository } from 'typeorm';
import { TenantCrudService } from '../common/crud/tenant-crud.service';
import { isPgError, PG_UNIQUE_VIOLATION } from '../common/utils/pg-error';
import { requestContext } from '../common/context/request-context';
import { Customer } from '../database/entities/customer.entity';
import { CustomerGroup } from '../database/entities/customer-group.entity';
import { CustomerFieldDefinition } from '../database/entities/customer-field-definition.entity';
import {
  ConsentChannel,
  CustomerConsentEvent,
} from '../database/entities/customer-consent-event.entity';
import { ListCustomersQueryDto } from './customers.dto';
import { applyCustomFields, CustomFieldValues } from './customer-fields';
import { containsPattern } from '../common/utils/like';

/** Fields accepted on create/update besides the customer's own columns */
export interface CustomerExtras {
  customFields?: Record<string, unknown>;
  consentSource?: string;
}

type CustomerInput = DeepPartial<Customer> & CustomerExtras;

const CONSENT_FIELDS = [
  ['email', 'marketingEmailConsent'],
  ['sms', 'marketingSmsConsent'],
] as const satisfies readonly (readonly [ConsentChannel, keyof Customer])[];

/**
 * Credit limits are customer finance: only users who may see them may set them.
 * Calls outside a signed-in request (imports, seeds) are not restricted here.
 */
export function assertCanSetCreditLimit(data: {
  creditLimit?: number | null;
  creditHold?: boolean | null;
  paymentTermDays?: number | null;
}) {
  const permissions = requestContext.get()?.permissions;
  if (
    data.creditLimit !== undefined &&
    permissions &&
    !permissions.includes('customers.finance.view')
  ) {
    throw new ForbiddenException(
      "You don't have permission to set a customer's credit limit",
    );
  }
  if (
    (data.creditHold !== undefined || data.paymentTermDays !== undefined) &&
    permissions &&
    !permissions.includes('customers.credit.manage')
  ) {
    throw new ForbiddenException(
      "You don't have permission to change a customer's credit hold or payment terms",
    );
  }
}

/**
 * The account balance and loyalty points are projections of their ledgers
 * (customer_credit_entries, loyalty_transactions): never written directly.
 */
export function assertNoProjectionWrite(data: object) {
  for (const field of ['currentBalance', 'loyaltyPoints'] as const) {
    if ((data as Record<string, unknown>)[field] !== undefined) {
      throw new BadRequestException(
        field === 'currentBalance'
          ? 'The account balance changes only through account entries (payments, adjustments)'
          : 'Loyalty points change only through the loyalty ledger (adjustments)',
      );
    }
  }
}

// Personal details a till user doesn't need to find and serve a customer
const PERSONAL_FIELDS = ['dateOfBirth', 'taxNumber'] as const;
// Personal keys some stores keep in metadata (custom fields stay visible)
const PERSONAL_METADATA_KEYS = [
  'address',
  'addresses',
  'billingAddress',
  'shippingAddress',
  'idNumber',
  'nationalId',
] as const;

/** Whether `permissions` reveal a customer's personal details */
export const canSeePersonalDetails = (permissions?: readonly string[] | null) =>
  !permissions ||
  permissions.includes('customers.manage') ||
  permissions.includes('customers.finance.view');

/**
 * The customer as the signed-in user may see it: without date of birth, tax
 * number and addresses kept in metadata unless they hold customers.manage or
 * customers.finance.view. Calls outside a signed-in request (imports, jobs) get
 * everything. The entity itself is never modified (it may be cached).
 */
export function customerForViewer<T extends Partial<Customer>>(
  customer: T,
  permissions: readonly string[] | null | undefined = requestContext.get()
    ?.permissions,
): T {
  if (canSeePersonalDetails(permissions)) return customer;
  const copy = Object.assign(
    Object.create(Object.getPrototypeOf(customer) as object | null) as T,
    customer,
  );
  for (const field of PERSONAL_FIELDS) delete copy[field];
  if (copy.metadata && typeof copy.metadata === 'object') {
    const metadata = { ...(copy.metadata as Record<string, unknown>) };
    for (const key of PERSONAL_METADATA_KEYS) delete metadata[key];
    copy.metadata = metadata;
  }
  return copy;
}

@Injectable()
export class CustomersService extends TenantCrudService<Customer> {
  protected readonly entityName = 'Customer';

  constructor(
    @InjectRepository(Customer) repository: Repository<Customer>,
    private dataSource: DataSource,
  ) {
    super(repository);
  }

  search(tenantId: string, query: ListCustomersQueryDto): Promise<Customer[]> {
    const qb = this.repository
      .createQueryBuilder('customer')
      .leftJoinAndSelect('customer.group', 'group')
      .where('customer.tenantId = :tenantId', { tenantId })
      .orderBy('customer.lastName', 'ASC', 'NULLS LAST')
      .addOrderBy('customer.firstName', 'ASC', 'NULLS LAST')
      .take(200);

    if (query.includeMerged !== 'true') {
      qb.andWhere('customer.mergedIntoId IS NULL');
    }
    if (query.status) {
      qb.andWhere('customer.status = :status', { status: query.status });
    }
    if (query.groupId) {
      qb.andWhere('customer.groupId = :groupId', { groupId: query.groupId });
    }
    if (query.search) {
      qb.andWhere(
        `(customer.code ILIKE :search OR customer.email ILIKE :search OR customer.phone ILIKE :search
          OR customer.companyName ILIKE :search
          OR CONCAT_WS(' ', customer.firstName, customer.lastName) ILIKE :search)`,
        { search: containsPattern(query.search) },
      );
    }
    return qb.getMany();
  }

  async findOne(tenantId: string, id: string): Promise<Customer> {
    const customer = await this.repository.findOne({
      where: { id, tenantId },
      relations: { group: true },
    });
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }
    return customer;
  }

  async create(tenantId: string, input: CustomerInput) {
    const { customFields, consentSource, ...data } = input;
    assertNoProjectionWrite(data);
    assertCanSetCreditLimit(data);
    if (!data.firstName && !data.lastName && !data.companyName) {
      throw new BadRequestException(
        'A customer needs a name or a company name',
      );
    }
    await this.assertGroup(tenantId, data.groupId);
    const metadata = { ...((data.metadata as object) ?? {}) } as Record<
      string,
      unknown
    >;
    if (customFields !== undefined) {
      metadata.customFields = await this.validateCustomFields(
        tenantId,
        customFields,
        {},
      );
    }
    const consentGiven = CONSENT_FIELDS.some(
      ([, field]) => data[field] !== undefined,
    );
    const code = data.code || (await this.nextCode(tenantId));

    const id = await this.transaction(async (manager) => {
      const repo = manager.getRepository(Customer);
      const customer = await repo.save(
        repo.create({
          ...data,
          code,
          tenantId,
          metadata,
          ...(consentGiven && {
            consentUpdatedAt: new Date(),
            consentSource: consentSource || 'admin',
          }),
        }),
      );
      await this.recordConsent(
        manager,
        customer,
        CONSENT_FIELDS.filter(([, field]) => data[field] !== undefined).map(
          ([channel, field]) => [channel, !!data[field]],
        ),
        consentSource,
      );
      return customer.id;
    });
    return this.findOne(tenantId, id);
  }

  async update(tenantId: string, id: string, input: CustomerInput) {
    const { customFields, consentSource, ...data } = input;
    assertNoProjectionWrite(data);
    assertCanSetCreditLimit(data);
    const current = await this.findOne(tenantId, id);
    if (data.groupId !== undefined) {
      await this.assertGroup(tenantId, data.groupId);
    }
    const next = { ...current, ...data };
    if (!next.firstName && !next.lastName && !next.companyName) {
      throw new BadRequestException(
        'A customer needs a name or a company name',
      );
    }

    // Only the fields that were sent (DTO instances carry unset fields as undefined)
    const patch: DeepPartial<Customer> = Object.fromEntries(
      Object.entries(data).filter(([, value]) => value !== undefined),
    );
    if (customFields !== undefined) {
      const currentValues =
        (current.metadata?.customFields as CustomFieldValues | undefined) ?? {};
      patch.metadata = {
        ...(current.metadata ?? {}),
        customFields: await this.validateCustomFields(
          tenantId,
          customFields,
          currentValues,
        ),
      };
    }
    const consentChanges = CONSENT_FIELDS.filter(
      ([, field]) =>
        data[field] !== undefined && !!data[field] !== current[field],
    ).map(([channel, field]) => [channel, !!data[field]] as const);
    if (consentChanges.length) {
      patch.consentUpdatedAt = new Date();
      patch.consentSource = consentSource || 'admin';
    }

    await this.transaction(async (manager) => {
      const repo = manager.getRepository(Customer);
      // Update columns only, so the loaded group relation isn't re-saved over groupId
      if (Object.keys(patch).length) {
        await repo.update({ id, tenantId }, patch);
      }
      await this.recordConsent(manager, current, consentChanges, consentSource);
    });
    return this.findOne(tenantId, id);
  }

  /** Consent history, newest first */
  async consentHistory(
    tenantId: string,
    customerId: string,
  ): Promise<CustomerConsentEvent[]> {
    await this.findOne(tenantId, customerId);
    return this.dataSource.getRepository(CustomerConsentEvent).find({
      where: { tenantId, customerId },
      order: { createdAt: 'DESC' },
      take: 200,
    });
  }

  private async recordConsent(
    manager: EntityManager,
    customer: Customer,
    changes: (readonly [ConsentChannel, boolean])[],
    source?: string,
  ) {
    if (!changes.length) return;
    const repo = manager.getRepository(CustomerConsentEvent);
    const recordedById = requestContext.get()?.userId ?? null;
    await repo.save(
      changes.map(([channel, granted]) =>
        repo.create({
          tenantId: customer.tenantId,
          customerId: customer.id,
          channel,
          granted,
          source: source || 'admin',
          recordedById,
        }),
      ),
    );
  }

  private async validateCustomFields(
    tenantId: string,
    input: Record<string, unknown>,
    current: CustomFieldValues,
  ): Promise<CustomFieldValues> {
    const definitions = await this.dataSource
      .getRepository(CustomerFieldDefinition)
      .find({ where: { tenantId } });
    const { values, errors } = applyCustomFields(definitions, input, current);
    if (errors.length) {
      throw new BadRequestException(errors);
    }
    return values;
  }

  private async assertGroup(tenantId: string, groupId?: string | null) {
    if (!groupId) return;
    const exists = await this.dataSource
      .getRepository(CustomerGroup)
      .exists({ where: { id: groupId, tenantId } });
    if (!exists) {
      throw new BadRequestException('Customer group not found');
    }
  }

  // Duplicate codes become 409s, like the other CRUD resources
  private async transaction<T>(
    work: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.dataSource.transaction(work);
    } catch (error) {
      if (isPgError(error, PG_UNIQUE_VIOLATION)) {
        throw new ConflictException('A customer with this code already exists');
      }
      throw error;
    }
  }

  // Next sequential code, e.g. CUST-000042
  private async nextCode(tenantId: string): Promise<string> {
    const [{ max }] = await this.repository.query<{ max: number | null }[]>(
      `SELECT MAX(CAST(SUBSTRING(code FROM 6) AS INTEGER)) AS max
       FROM customers WHERE "tenantId" = $1 AND code ~ '^CUST-[0-9]+$'`,
      [tenantId],
    );
    return `CUST-${String((max ?? 0) + 1).padStart(6, '0')}`;
  }
}
