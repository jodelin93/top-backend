import {
  agingOf,
  allocateFifo,
  availableCredit,
  buildStatement,
  daysPastDue,
  dueDateFor,
  ledgerSum,
  paymentTerms,
  sumAging,
} from './credit-math';

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

describe('customer account math', () => {
  describe('ledger balance', () => {
    it('is the exact sum of the signed entries', () => {
      // 0.1 + 0.2 style amounts must not drift
      expect(ledgerSum([100.1, -0.2, '0.1', -50, 25.33])).toBe(75.33);
      expect(ledgerSum([])).toBe(0);
    });
  });

  describe('FIFO allocation', () => {
    const debits = [
      {
        id: 'c2',
        open: 50,
        dueDate: '2026-02-01',
        createdAt: day('2026-01-02'),
      },
      {
        id: 'c1',
        open: 30,
        dueDate: '2026-01-15',
        createdAt: day('2026-01-01'),
      },
    ];

    it('settles the oldest due charge first', () => {
      const result = allocateFifo(debits, [
        { id: 'p1', open: 40, createdAt: day('2026-02-10') },
      ]);
      expect(result).toEqual([
        { debitEntryId: 'c1', creditEntryId: 'p1', amount: 30 },
        { debitEntryId: 'c2', creditEntryId: 'p1', amount: 10 },
      ]);
    });

    it('never allocates more than a charge has open or a payment has left', () => {
      const result = allocateFifo(debits, [
        { id: 'p1', open: 70, createdAt: day('2026-02-10') },
        { id: 'p2', open: 70, createdAt: day('2026-02-11') },
      ]);
      const perDebit = (id: string) =>
        result
          .filter((a) => a.debitEntryId === id)
          .reduce((s, a) => s + a.amount, 0);
      const perCredit = (id: string) =>
        result
          .filter((a) => a.creditEntryId === id)
          .reduce((s, a) => s + a.amount, 0);
      expect(perDebit('c1')).toBe(30);
      expect(perDebit('c2')).toBe(50);
      expect(perCredit('p1')).toBe(70);
      expect(perCredit('p2')).toBe(10);
      expect(result.every((a) => a.amount > 0)).toBe(true);
    });

    it('lets a reversal / credit note settle its own charge first', () => {
      const result = allocateFifo(debits, [
        {
          id: 'r1',
          open: 20,
          createdAt: day('2026-02-10'),
          targetDebitId: 'c2',
        },
      ]);
      expect(result).toEqual([
        { debitEntryId: 'c2', creditEntryId: 'r1', amount: 20 },
      ]);
    });

    it('handles cents exactly', () => {
      const result = allocateFifo(
        [{ id: 'c', open: 0.3, dueDate: null, createdAt: day('2026-01-01') }],
        [
          { id: 'a', open: 0.1, createdAt: day('2026-01-02') },
          { id: 'b', open: 0.2, createdAt: day('2026-01-03') },
        ],
      );
      expect(result.map((a) => a.amount)).toEqual([0.1, 0.2]);
    });
  });

  describe('aging', () => {
    const asOf = day('2026-06-30');

    it('puts open charges in current, 1–30, 31–60, 61–90 and 90+ days past due', () => {
      const aging = agingOf(
        [
          { open: 10, dueDate: '2026-07-15' }, // not due yet
          { open: 20, dueDate: '2026-06-30' }, // due today: current
          { open: 30, dueDate: '2026-06-29' }, // 1 day
          { open: 40, dueDate: '2026-05-31' }, // 30 days
          { open: 50, dueDate: '2026-05-30' }, // 31 days
          { open: 60, dueDate: '2026-04-01' }, // 90 days
          { open: 70, dueDate: '2026-03-31' }, // 91 days
        ],
        asOf,
      );
      expect(aging).toEqual({
        current: 30,
        d1_30: 70,
        d31_60: 50,
        d61_90: 60,
        d90_plus: 70,
        total: 280,
      });
    });

    it('takes unapplied credit off the total only', () => {
      const aging = agingOf([{ open: 100, dueDate: '2026-06-01' }], asOf, 25);
      expect(aging.d1_30).toBe(100);
      expect(aging.total).toBe(75);
    });

    it('counts days past due in whole days', () => {
      expect(daysPastDue('2026-06-29', asOf)).toBe(1);
      expect(daysPastDue(null, asOf)).toBe(0);
    });

    it('adds up per bucket', () => {
      const one = agingOf([{ open: 10.1, dueDate: '2026-06-01' }], asOf);
      const two = agingOf([{ open: 0.2, dueDate: '2026-06-01' }], asOf);
      expect(sumAging([one, two]).d1_30).toBe(10.3);
    });
  });

  describe('terms, limit and statement', () => {
    it('uses the customer terms, else the group, else 30 days', () => {
      expect(
        paymentTerms({ paymentTermDays: 7 }, { defaultPaymentTermDays: 60 }),
      ).toBe(7);
      expect(
        paymentTerms({ paymentTermDays: null }, { defaultPaymentTermDays: 60 }),
      ).toBe(60);
      expect(paymentTerms({}, null)).toBe(30);
      expect(dueDateFor(day('2026-01-31'), 30)).toBe('2026-03-02');
    });

    it('never shows negative available credit', () => {
      expect(availableCredit(500, 120.5)).toBe(379.5);
      expect(availableCredit(100, 150)).toBe(0);
    });

    it('closes at opening + entries, with a running balance', () => {
      const statement = buildStatement(100, [
        { id: 'a', createdAt: day('2026-01-02'), type: 'charge', amount: 50 },
        {
          id: 'b',
          createdAt: day('2026-01-03'),
          type: 'payment',
          amount: '-120.25',
        },
      ]);
      expect(statement.lines.map((l) => l.balance)).toEqual([150, 29.75]);
      expect(statement.totalCharges).toBe(50);
      expect(statement.totalCredits).toBe(120.25);
      expect(statement.closingBalance).toBe(29.75);
    });
  });
});
