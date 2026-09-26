import { MergeableCustomer, resolveMergedCustomer } from './customer-merge';

const base: MergeableCustomer = {
  customerType: 'individual',
  firstName: null,
  lastName: null,
  companyName: null,
  email: null,
  phone: null,
  taxNumber: null,
  dateOfBirth: null,
  locale: null,
  groupId: null,
  creditLimit: 0,
  currentBalance: 0,
  loyaltyPoints: 0,
  metadata: {},
  marketingEmailConsent: false,
  marketingSmsConsent: false,
  consentUpdatedAt: null,
  consentSource: null,
  lastPurchaseAt: null,
};

describe('resolveMergedCustomer', () => {
  const survivor: MergeableCustomer = {
    ...base,
    firstName: 'Ann',
    lastName: 'Lee',
    email: 'ann@old.test',
    loyaltyPoints: 120,
    currentBalance: 10.1,
    metadata: { customFields: { card: 'A1' }, note: 's' },
    consentUpdatedAt: new Date('2024-01-01'),
    marketingEmailConsent: true,
    lastPurchaseAt: new Date('2024-03-01'),
  };
  const merged: MergeableCustomer = {
    ...base,
    firstName: 'Anne',
    lastName: 'Lee',
    email: 'ann@new.test',
    phone: '555-0100',
    loyaltyPoints: 30,
    currentBalance: 5.25,
    metadata: { customFields: { card: 'B2', vip: true } },
    consentUpdatedAt: new Date('2024-06-01'),
    marketingSmsConsent: true,
    consentSource: 'pos',
    lastPurchaseAt: new Date('2024-05-01'),
  };

  it('keeps the survivor values unless the merged ones are chosen', () => {
    const result = resolveMergedCustomer(survivor, merged, { email: 'merged' });
    expect(result.firstName).toBe('Ann');
    expect(result.email).toBe('ann@new.test');
  });

  it('fills empty survivor fields from the merged record', () => {
    expect(resolveMergedCustomer(survivor, merged).phone).toBe('555-0100');
    // ...unless the survivor's (empty) value is chosen explicitly
    expect(
      resolveMergedCustomer(survivor, merged, { phone: 'survivor' }).phone,
    ).toBeNull();
  });

  it('adds up loyalty points and balances', () => {
    const result = resolveMergedCustomer(survivor, merged);
    expect(result.loyaltyPoints).toBe(150);
    expect(result.currentBalance).toBe(15.35);
  });

  it('keeps the most recent consent decision', () => {
    const result = resolveMergedCustomer(survivor, merged);
    expect(result.marketingEmailConsent).toBe(false);
    expect(result.marketingSmsConsent).toBe(true);
    expect(result.consentSource).toBe('pos');
  });

  it('merges custom fields with the survivor winning', () => {
    expect(resolveMergedCustomer(survivor, merged).metadata).toEqual({
      note: 's',
      customFields: { card: 'A1', vip: true },
    });
  });

  it('keeps the latest purchase date', () => {
    expect(resolveMergedCustomer(survivor, merged).lastPurchaseAt).toEqual(
      new Date('2024-05-01'),
    );
  });
});
