import {
  addDays,
  agingBucket,
  AllocatableInvoice,
  allocationError,
  autoAllocate,
  buildStatement,
  computeAging,
  matchInvoiceLine,
  planSupplierReturn,
} from './payables.logic';
import { suggestedReorderQuantity } from './reorder.logic';

describe('3-way match', () => {
  it('computes price and quantity variances exactly', () => {
    const result = matchInvoiceLine(
      {
        quantity: 3,
        unitPrice: 10.35,
        expectedUnitPrice: 10,
        matchableQuantity: 3,
      },
      5,
    );
    // (10.35 − 10) × 3 = 1.05 (not 1.0499999…)
    expect(result.priceVariance).toBe(1.05);
    expect(result.priceVariancePercent).toBe(3.5);
    expect(result.quantityVariance).toBe(0);
    // 3.5% is inside the 5% tolerance
    expect(result.flagged).toBe(false);
  });

  it('flags a price above the order price beyond the tolerance', () => {
    const result = matchInvoiceLine(
      {
        quantity: 4,
        unitPrice: 11,
        expectedUnitPrice: 10,
        matchableQuantity: 4,
      },
      5,
    );
    expect(result).toMatchObject({
      priceVariance: 4,
      priceVariancePercent: 10,
      flagged: true,
    });
    expect(result.reasons[0]).toMatch(/10% above the order \(tolerance 5%\)/);
  });

  it('does not flag a price below the order price', () => {
    const result = matchInvoiceLine(
      {
        quantity: 2,
        unitPrice: 9,
        expectedUnitPrice: 10,
        matchableQuantity: 2,
      },
      0,
    );
    expect(result).toMatchObject({
      priceVariance: -2,
      priceVariancePercent: -10,
      flagged: false,
    });
  });

  it('flags billing for more than was received and not yet invoiced', () => {
    const result = matchInvoiceLine(
      { quantity: 6, unitPrice: 5, expectedUnitPrice: 5, matchableQuantity: 4 },
      0,
    );
    expect(result).toMatchObject({ quantityVariance: 2, flagged: true });
    // Billing fewer units than received is fine (the rest may come later)
    expect(
      matchInvoiceLine(
        {
          quantity: 2,
          unitPrice: 5,
          expectedUnitPrice: 5,
          matchableQuantity: 4,
        },
        0,
      ),
    ).toMatchObject({ quantityVariance: -2, flagged: false });
  });

  it('flags any price on a free order line', () => {
    expect(
      matchInvoiceLine(
        {
          quantity: 1,
          unitPrice: 1,
          expectedUnitPrice: 0,
          matchableQuantity: 1,
        },
        50,
      ),
    ).toMatchObject({ priceVariancePercent: null, flagged: true });
  });
});

describe('aging', () => {
  const asOf = '2026-09-24';

  it('buckets by days past the due date', () => {
    expect(agingBucket('2026-09-30', asOf)).toBe('current');
    expect(agingBucket('2026-09-24', asOf)).toBe('current');
    expect(agingBucket('2026-09-23', asOf)).toBe('days1to30');
    expect(agingBucket('2026-08-25', asOf)).toBe('days1to30'); // 30 days
    expect(agingBucket('2026-08-24', asOf)).toBe('days31to60'); // 31 days
    expect(agingBucket('2026-07-26', asOf)).toBe('days31to60'); // 60
    expect(agingBucket('2026-07-25', asOf)).toBe('days61to90'); // 61
    expect(agingBucket('2026-06-26', asOf)).toBe('days61to90'); // 90
    expect(agingBucket('2026-06-25', asOf)).toBe('over90'); // 91
  });

  it('ages what is still owed and derives the balance', () => {
    const result = computeAging(
      [
        { dueDate: '2026-10-10', total: 100, allocated: 0 },
        // partly paid, 10 days overdue
        { dueDate: '2026-09-14', total: 250.1, allocated: 50.05 },
        // fully paid: not aged
        { dueDate: '2026-05-01', total: 80, allocated: 80 },
        { dueDate: '2026-05-01', total: 0.3, allocated: 0.1 },
      ],
      20.02,
      asOf,
    );
    expect(result).toEqual({
      current: 100,
      days1to30: 200.05,
      days31to60: 0,
      days61to90: 0,
      over90: 0.2,
      unapplied: 20.02,
      // 100 + 200.05 + 0.2 − 20.02
      balance: 280.23,
    });
  });
});

describe('allocation', () => {
  const invoices = new Map<string, AllocatableInvoice>([
    ['i1', { id: 'i1', supplierId: 's1', status: 'open', openAmount: 100 }],
    ['i2', { id: 'i2', supplierId: 's1', status: 'open', openAmount: 40.5 }],
    [
      'held',
      {
        id: 'held',
        supplierId: 's1',
        status: 'pending_approval',
        openAmount: 10,
      },
    ],
    [
      'other',
      { id: 'other', supplierId: 's2', status: 'open', openAmount: 10 },
    ],
  ]);
  const check = (
    available: number,
    requests: { invoiceId: string; amount: number }[],
  ) => allocationError({ supplierId: 's1', available, invoices, requests });

  it('allows partial allocations within both limits', () => {
    expect(
      check(120, [
        { invoiceId: 'i1', amount: 79.5 },
        { invoiceId: 'i2', amount: 40.5 },
      ]),
    ).toBeNull();
  });

  it('never allocates more than the payment has left', () => {
    expect(
      check(100, [
        { invoiceId: 'i1', amount: 60 },
        { invoiceId: 'i2', amount: 40.01 },
      ]),
    ).toMatch(/Only 100.00 is left/);
  });

  it('never allocates more than an invoice still owes (even split in two)', () => {
    expect(check(500, [{ invoiceId: 'i2', amount: 40.51 }])).toMatch(
      /Only 40.50 is still owed/,
    );
    expect(
      check(500, [
        { invoiceId: 'i2', amount: 20.25 },
        { invoiceId: 'i2', amount: 20.26 },
      ]),
    ).toMatch(/still owed/);
  });

  it('refuses other suppliers, unapproved invoices and non-positive amounts', () => {
    expect(check(50, [{ invoiceId: 'other', amount: 5 }])).toMatch(
      /another supplier/,
    );
    expect(check(50, [{ invoiceId: 'held', amount: 5 }])).toMatch(/open/);
    expect(check(50, [{ invoiceId: 'i1', amount: 0 }])).toMatch(/positive/);
    expect(check(50, [{ invoiceId: 'missing', amount: 1 }])).not.toBeNull();
  });

  it('auto-allocates oldest due first without over-allocating', () => {
    expect(
      autoAllocate(130, [
        { id: 'b', dueDate: '2026-09-10', openAmount: 100 },
        { id: 'a', dueDate: '2026-08-01', openAmount: 50 },
        { id: 'c', dueDate: '2026-10-01', openAmount: 10 },
      ]),
    ).toEqual([
      { invoiceId: 'a', amount: 50 },
      { invoiceId: 'b', amount: 80 },
    ]);
  });
});

describe('supplier returns', () => {
  const lines = [
    {
      id: 'r1',
      variantId: 'v1',
      quantity: 10,
      accepted: true,
      quantityReturned: 3,
      unitCost: 2.345,
    },
    // Rejected damaged units never went into stock
    {
      id: 'r2',
      variantId: 'v1',
      quantity: 4,
      accepted: false,
      quantityReturned: 0,
      unitCost: 2.345,
    },
  ];

  it('returns at most received − already returned', () => {
    expect(
      planSupplierReturn(lines, [{ receiptItemId: 'r1', quantity: 8 }]),
    ).toEqual({
      error:
        'Only 7 unit(s) of a receipt line can still be returned (8 requested)',
    });
    const ok = planSupplierReturn(lines, [
      { receiptItemId: 'r1', quantity: 7 },
    ]);
    // 7 × 2.345 = 16.415 → 16.42
    expect(ok).toMatchObject({ total: 16.42, lines: [{ quantity: 7 }] });
  });

  it('cannot return rejected units, other receipts’ lines or nothing', () => {
    expect(
      planSupplierReturn(lines, [{ receiptItemId: 'r2', quantity: 1 }]),
    ).toHaveProperty('error', expect.stringMatching(/Only 0/) as string);
    expect(
      planSupplierReturn(lines, [{ receiptItemId: 'x', quantity: 1 }]),
    ).toHaveProperty('error');
    expect(
      planSupplierReturn(lines, [{ receiptItemId: 'r1', quantity: 0 }]),
    ).toEqual({ error: 'Nothing to return' });
    expect(
      planSupplierReturn(lines, [
        { receiptItemId: 'r1', quantity: 1 },
        { receiptItemId: 'r1', quantity: 1 },
      ]),
    ).toHaveProperty('error');
  });
});

describe('statement', () => {
  it('carries an opening balance and a running balance', () => {
    const result = buildStatement(
      [
        {
          date: '2026-08-01',
          type: 'invoice',
          id: '1',
          number: 'A-1',
          description: '',
          amount: 100,
        },
        {
          date: '2026-08-20',
          type: 'payment',
          id: '2',
          number: 'SP-1',
          description: '',
          amount: 60,
        },
        {
          date: '2026-09-02',
          type: 'invoice',
          id: '3',
          number: 'A-2',
          description: '',
          amount: 40.1,
        },
        {
          date: '2026-09-05',
          type: 'credit',
          id: '4',
          number: 'SC-1',
          description: '',
          amount: 0.2,
        },
        {
          date: '2026-10-01',
          type: 'invoice',
          id: '5',
          number: 'A-3',
          description: '',
          amount: 999,
        },
      ],
      '2026-09-01',
      '2026-09-30',
    );
    expect(result.openingBalance).toBe(40);
    expect(
      result.lines.map((l) => [l.number, l.debit, l.credit, l.balance]),
    ).toEqual([
      ['A-2', 40.1, 0, 80.1],
      ['SC-1', 0, 0.2, 79.9],
    ]);
    expect(result.closingBalance).toBe(79.9);
    expect(addDays('2026-01-31', 30)).toBe('2026-03-02');
  });
});

describe('reorder suggestions', () => {
  const base = {
    onHand: 3,
    onOrder: 0,
    reorderPoint: 5,
    reorderQuantity: null,
    maxStockLevel: null,
  };

  it('suggests only at or below the reorder point, counting what is on order', () => {
    expect(suggestedReorderQuantity({ ...base, onHand: 6 })).toBeNull();
    expect(suggestedReorderQuantity({ ...base, onOrder: 3 })).toBeNull();
    expect(
      suggestedReorderQuantity({ ...base, reorderPoint: null }),
    ).toBeNull();
    expect(suggestedReorderQuantity({ ...base, onHand: 5 })).toBe(1);
  });

  it('orders the reorder quantity, else up to the maximum, at least the minimum', () => {
    expect(suggestedReorderQuantity({ ...base, reorderQuantity: 24 })).toBe(24);
    expect(
      suggestedReorderQuantity({ ...base, maxStockLevel: 20, onOrder: 1 }),
    ).toBe(16);
    expect(suggestedReorderQuantity({ ...base, minOrderQty: 12 })).toBe(12);
  });
});
