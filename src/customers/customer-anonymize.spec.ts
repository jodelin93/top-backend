import { ConflictException, NotFoundException } from '@nestjs/common';
import { CustomerStatus } from '../database/entities/customer.entity';
import { CustomerAddress } from '../database/entities/customer-address.entity';
import { CustomerContact } from '../database/entities/customer-contact.entity';
import { CustomerNote } from '../database/entities/customer-note.entity';
import {
  ANONYMISED_NAME,
  anonymisedCustomerPatch,
  assertNothingOwed,
  CustomerAnonymizeService,
  REMOVED_NOTE,
} from './customer-anonymize.service';

describe('customer anonymisation', () => {
  it('refuses while money is owed either way', () => {
    expect(() => assertNothingOwed('12.5000', [])).toThrow(ConflictException);
    expect(() => assertNothingOwed(-3, [])).toThrow(ConflictException);
    expect(() => assertNothingOwed('0.0000', ['0', '4.0000'])).toThrow(
      ConflictException,
    );
    expect(() => assertNothingOwed('0.0000', ['0.0000'])).not.toThrow();
  });

  it('clears every personal field and withdraws consent', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(anonymisedCustomerPatch(now)).toEqual({
      firstName: null,
      lastName: null,
      companyName: ANONYMISED_NAME,
      email: null,
      phone: null,
      taxNumber: null,
      dateOfBirth: null,
      metadata: { anonymisedAt: '2026-01-01T00:00:00.000Z' },
      marketingEmailConsent: false,
      marketingSmsConsent: false,
      consentUpdatedAt: now,
      consentSource: 'anonymisation',
      status: CustomerStatus.INACTIVE,
    });
  });

  function setup(customer: object | null, balances: string[] = []) {
    const qb = (result: unknown) => {
      const b: Record<string, jest.Mock> = {};
      for (const m of ['select', 'where', 'setLock']) {
        b[m] = jest.fn(() => b);
      }
      b.getOne = jest.fn().mockResolvedValue(result);
      b.getMany = jest.fn().mockResolvedValue(result);
      return b;
    };
    const customerRepo = {
      createQueryBuilder: jest.fn(() => qb(customer)),
      update: jest.fn(),
    };
    const accountRepo = {
      createQueryBuilder: jest.fn(() =>
        qb(balances.map((balance, i) => ({ id: `a${i}`, balance }))),
      ),
    };
    const eventRepo = {
      create: jest.fn((x: object) => x),
      save: jest.fn(),
    };
    const repos = [customerRepo, accountRepo, eventRepo];
    let n = 0;
    const manager = {
      getRepository: jest.fn(() => repos[n++]),
      delete: jest.fn(),
      update: jest.fn(),
      query: jest.fn(),
    };
    const dataSource = {
      transaction: jest.fn((work: (m: unknown) => unknown) => work(manager)),
    };
    const audit = { record: jest.fn() };
    const service = new CustomerAnonymizeService(
      dataSource as never,
      audit as never,
    );
    return { service, manager, customerRepo, eventRepo, audit };
  }

  it('anonymises in one transaction and audits the id only', async () => {
    const { service, manager, customerRepo, eventRepo, audit } = setup(
      {
        id: 'c1',
        currentBalance: '0.0000',
        marketingEmailConsent: true,
        marketingSmsConsent: false,
      },
      ['0.0000'],
    );
    await service.anonymize('t1', 'c1');
    expect(customerRepo.update).toHaveBeenCalledWith(
      { id: 'c1', tenantId: 't1' },
      expect.objectContaining({ email: null, companyName: ANONYMISED_NAME }),
    );
    expect(manager.delete).toHaveBeenCalledWith(CustomerAddress, {
      tenantId: 't1',
      customerId: 'c1',
    });
    expect(manager.delete).toHaveBeenCalledWith(CustomerContact, {
      tenantId: 't1',
      customerId: 'c1',
    });
    expect(manager.update).toHaveBeenCalledWith(
      CustomerNote,
      { tenantId: 't1', customerId: 'c1' },
      { body: REMOVED_NOTE },
    );
    expect(eventRepo.save).toHaveBeenCalledWith([
      expect.objectContaining({ channel: 'email', granted: false }),
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      {
        tenantId: 't1',
        action: 'customer.anonymised',
        entityType: 'customer',
        entityId: 'c1',
      },
      manager,
    );
  });

  it('refuses with 409 when store credit remains, changing nothing', async () => {
    const { service, customerRepo, audit } = setup(
      { id: 'c1', currentBalance: '0' },
      ['5.0000'],
    );
    await expect(service.anonymize('t1', 'c1')).rejects.toThrow(
      ConflictException,
    );
    expect(customerRepo.update).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('404s for a customer of another tenant', async () => {
    const { service } = setup(null);
    await expect(service.anonymize('t2', 'c1')).rejects.toThrow(
      NotFoundException,
    );
  });
});
