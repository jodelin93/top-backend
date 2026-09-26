import { BadRequestException } from '@nestjs/common';
import { CustomerNoteVisibility } from '../database/entities/customer-note.entity';
import { canSeeManagerNotes, visibleNotes } from './customer-profile.service';
import {
  assertNoProjectionWrite,
  customerForViewer,
} from './customers.service';
import { Customer } from '../database/entities/customer.entity';

describe('customer notes visibility', () => {
  const notes = [
    { id: 'n1', visibility: CustomerNoteVisibility.ALL },
    { id: 'n2', visibility: CustomerNoteVisibility.MANAGERS },
  ];

  it('hides manager notes from users without customers.manage', () => {
    expect(visibleNotes(notes, ['customers.view']).map((n) => n.id)).toEqual([
      'n1',
    ]);
    expect(visibleNotes(notes, undefined).map((n) => n.id)).toEqual(['n1']);
    expect(canSeeManagerNotes(['customers.view'])).toBe(false);
  });

  it('shows every note to users with customers.manage', () => {
    expect(
      visibleNotes(notes, ['customers.view', 'customers.manage']).map(
        (n) => n.id,
      ),
    ).toEqual(['n1', 'n2']);
  });
});

describe('customer balance projection', () => {
  it('rejects a direct write of the balance or the points', () => {
    expect(() => assertNoProjectionWrite({ currentBalance: 10 })).toThrow(
      BadRequestException,
    );
    expect(() => assertNoProjectionWrite({ loyaltyPoints: 10 })).toThrow(
      BadRequestException,
    );
    expect(() => assertNoProjectionWrite({ firstName: 'Ann' })).not.toThrow();
  });
});

describe('customer personal details projection', () => {
  const customer = {
    id: 'c1',
    firstName: 'Ann',
    phone: '123',
    dateOfBirth: new Date('1990-01-01'),
    taxNumber: 'TX-1',
    metadata: { address: '1 Main St', customFields: { vip: true } },
  } as unknown as Customer;

  it('hides date of birth, tax number and addresses from till users', () => {
    const shown = customerForViewer(customer, [
      'customers.view',
      'customers.create',
    ]);
    expect(shown).not.toHaveProperty('dateOfBirth');
    expect(shown).not.toHaveProperty('taxNumber');
    expect(shown.metadata).toEqual({ customFields: { vip: true } });
    expect(shown.phone).toBe('123');
    // The entity itself is untouched
    expect(customer.taxNumber).toBe('TX-1');
    expect(customer.metadata.address).toBe('1 Main St');
  });

  it('shows everything to managers, finance and non-request callers', () => {
    expect(customerForViewer(customer, ['customers.manage'])).toBe(customer);
    expect(customerForViewer(customer, ['customers.finance.view'])).toBe(
      customer,
    );
    expect(customerForViewer(customer, undefined)).toBe(customer);
  });
});
