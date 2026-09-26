import type { AuthUser } from '../auth/strategies/jwt.strategy';
import { eventForViewer } from './system-events.controller';

describe('eventForViewer (outbox payloads on the System events page)', () => {
  const event = {
    id: 'e1',
    eventType: 'customer.credit_changed',
    payload: {
      customerId: 'c1',
      previousBalance: 120,
      newBalance: 80,
      creditLimit: 500,
      reason: 'payment',
    },
  };

  it('leaves out balances for users without customers.finance.view', () => {
    const operator = { permissions: ['platform.operate'] } as AuthUser;
    const shown = eventForViewer(event, operator);
    expect(shown.payload).toEqual({ customerId: 'c1', reason: 'payment' });
    // The stored event is not modified
    expect(event.payload.newBalance).toBe(80);
  });

  it('shows them with customers.finance.view', () => {
    const finance = {
      permissions: ['settings.manage', 'customers.finance.view'],
    } as AuthUser;
    expect(eventForViewer(event, finance)).toBe(event);
  });

  it('keeps payloads without balances as they are', () => {
    const other = { id: 'e2', payload: { shiftId: 's1' } };
    expect(eventForViewer(other, { permissions: [] })).toEqual(other);
  });
});
