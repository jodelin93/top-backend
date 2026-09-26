import { EntityManager, Repository } from 'typeorm';
import {
  LoyaltyTransaction,
  LoyaltyTransactionType,
} from '../database/entities/loyalty-transaction.entity';
import type { SettingsService } from '../settings/settings.service';
import type { AuditService } from '../audit/audit.service';
import { LoyaltyService } from './loyalty.service';
import { applyPointChange } from './loyalty-math';

const TENANT = 'tenant-1';
const CUSTOMER = 'customer-1';

/** In-memory customer balance + ledger behind a fake EntityManager */
function setup(balance: number, ledger: Partial<LoyaltyTransaction>[] = []) {
  const state = { balance, ledger: [...ledger] };
  const manager = {
    query: jest.fn((sql: string, params: unknown[]) => {
      if (sql.includes('SELECT "loyaltyPoints"')) {
        return Promise.resolve([{ loyaltyPoints: state.balance }]);
      }
      if (sql.includes('UPDATE customers')) {
        state.balance = Number(params[0]);
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }),
    insert: jest.fn((_entity: unknown, row: Partial<LoyaltyTransaction>) => {
      state.ledger.push(row);
      return Promise.resolve();
    }),
    find: jest.fn(() => Promise.resolve(state.ledger)),
  } as unknown as EntityManager;
  const settings = {
    getSettings: jest.fn(() =>
      Promise.resolve({
        loyaltyEnabled: true,
        loyaltyEarnPercent: 1,
        loyaltyPointValue: 0.01,
        loyaltyMinRedeemPoints: 100,
        loyaltyMaxRedeemPercent: 100,
      }),
    ),
  };
  const service = new LoyaltyService(
    {} as Repository<LoyaltyTransaction>,
    settings as unknown as SettingsService,
    { record: jest.fn() } as unknown as AuditService,
  );
  const ledgerSum = () =>
    state.ledger.reduce((sum, row) => sum + Number(row.points ?? 0), 0);
  return { service, manager, state, ledgerSum };
}

describe('applyPointChange', () => {
  it('applies the full change when the balance allows it', () => {
    expect(applyPointChange(500, -200)).toEqual({
      applied: -200,
      balanceAfter: 300,
      shortfall: 0,
    });
    expect(applyPointChange(0, 150)).toEqual({
      applied: 150,
      balanceAfter: 150,
      shortfall: 0,
    });
  });

  it('removes only what is left and reports the shortfall', () => {
    expect(applyPointChange(30, -100)).toEqual({
      applied: -30,
      balanceAfter: 0,
      shortfall: 70,
    });
    expect(applyPointChange(0, -100)).toEqual({
      applied: 0,
      balanceAfter: 0,
      shortfall: 100,
    });
  });
});

describe('LoyaltyService ledger consistency', () => {
  it('keeps the balance equal to the ledger when a void reverses spent points', async () => {
    // Earned 100 on the sale, then spent 70 of them elsewhere: 30 left
    const { service, manager, state, ledgerSum } = setup(30, [
      {
        customerId: CUSTOMER,
        saleId: 'sale-1',
        type: LoyaltyTransactionType.EARN,
        points: 100,
      },
      {
        customerId: CUSTOMER,
        saleId: 'sale-2',
        type: LoyaltyTransactionType.REDEEM,
        points: -70,
      },
    ]);
    (manager.find as jest.Mock).mockResolvedValueOnce([state.ledger[0]]);

    await service.reverseSale(manager, TENANT, 'sale-1', 'Voided');

    expect(state.balance).toBe(0);
    const reversal = state.ledger[2];
    expect(reversal).toMatchObject({
      type: LoyaltyTransactionType.REVERSAL,
      points: -30,
      balanceAfter: 0,
    });
    expect(reversal.note).toContain('Voided');
    expect(reversal.note).toContain('70 of 100 points not taken back');
    expect(ledgerSum()).toBe(state.balance);
  });

  it('records the full reversal when the points are still there', async () => {
    const { service, manager, state, ledgerSum } = setup(100, [
      {
        customerId: CUSTOMER,
        saleId: 'sale-1',
        type: LoyaltyTransactionType.EARN,
        points: 100,
      },
    ]);
    await service.reverseSale(manager, TENANT, 'sale-1', 'Voided');
    expect(state.balance).toBe(0);
    expect(state.ledger[1]).toMatchObject({ points: -100, note: 'Voided' });
    expect(ledgerSum()).toBe(state.balance);
  });
});
