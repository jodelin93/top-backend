import {
  changedFieldNames,
  crudAuditChanges,
  maskPersonalData,
  REDACTED,
} from './audit-safe';

describe('audit-safe', () => {
  const customer = {
    id: 'c1',
    code: 'CUST-000001',
    firstName: 'Ann',
    lastName: 'Lee',
    email: 'ann@example.com',
    phone: '+509 1234',
    dateOfBirth: new Date('1990-01-01'),
    taxNumber: 'TX-1',
    currentBalance: '10.0000',
    metadata: { address: '1 Main St', customFields: { vip: true } },
  };

  it('records only ids and field names for customers', () => {
    const created = crudAuditChanges(
      'customer',
      'created',
      undefined,
      customer,
    );
    expect(created.after).toEqual({ id: 'c1' });
    expect(created.fields).toEqual(
      expect.arrayContaining(['email', 'firstName', 'metadata']),
    );
    const updated = crudAuditChanges('customer', 'updated', customer, {
      ...customer,
      email: 'new@example.com',
      currentBalance: 10,
    });
    expect(updated).toEqual({ changedFields: ['email'] });
    expect(crudAuditChanges('customer', 'deleted', customer)).toEqual({
      before: { id: 'c1' },
    });
    const json = JSON.stringify([created, updated]);
    for (const value of [
      'ann@example.com',
      'new@example.com',
      'Ann',
      '1 Main St',
      'TX-1',
    ]) {
      expect(json).not.toContain(value);
    }
  });

  it('keeps non-personal diffs of other resources readable', () => {
    const changes = crudAuditChanges(
      'product',
      'updated',
      { id: 'p1', name: 'Soap', price: '2.0000' },
      { id: 'p1', name: 'Soap', price: '2.5000' },
    );
    expect(changes).toEqual({
      before: { id: 'p1', name: 'Soap', price: '2.0000' },
      after: { id: 'p1', name: 'Soap', price: '2.5000' },
      changedFields: ['price'],
    });
  });

  it('masks personal fields at any depth, names and metadata of people', () => {
    expect(
      maskPersonalData(
        {
          name: 'Acme',
          email: 'a@b.c',
          phone: null,
          contacts: [{ contactName: 'Bo', role: 'buyer' }],
          metadata: { x: 1 },
        },
        'supplier',
      ),
    ).toEqual({
      name: REDACTED,
      email: REDACTED,
      phone: null,
      contacts: [{ contactName: REDACTED, role: 'buyer' }],
      metadata: REDACTED,
    });
    // A branch's name isn't personal, its email is masked anyway
    expect(
      maskPersonalData({ name: 'Main', email: 'x@y.z' }, 'branch'),
    ).toEqual({
      name: 'Main',
      email: REDACTED,
    });
  });

  it('lists changed fields, ignoring bookkeeping and numeric formatting', () => {
    expect(
      changedFieldNames(
        { a: 1, b: '5.0000', updatedAt: 1, version: 1, d: { x: 1 } },
        { a: 2, b: 5, updatedAt: 2, version: 2, d: { x: 1 }, e: null },
      ),
    ).toEqual(['a']);
  });
});
