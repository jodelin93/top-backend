import { PurchaseOrderStatus as S } from '../database/entities/purchase-order.entity';
import {
  canTransition,
  computeOrderTotals,
  maxReceivableWithinTolerance,
  netUnitCost,
  outstandingQuantity,
  planReceipt,
  planShortClose,
  revisionError,
  statusAfterReceipt,
  statusAfterRevision,
  statusAfterSubmit,
  transitionError,
} from './purchase-order.logic';

describe('purchase order lifecycle', () => {
  it('follows draft → approval → issued → received', () => {
    expect(canTransition(S.DRAFT, 'submit')).toBe(true);
    expect(canTransition(S.PENDING_APPROVAL, 'approve')).toBe(true);
    expect(canTransition(S.APPROVED, 'issue')).toBe(true);
    expect(canTransition(S.ISSUED, 'receive')).toBe(true);
    expect(canTransition(S.PARTIALLY_RECEIVED, 'receive')).toBe(true);
  });

  it('rejects out-of-order steps', () => {
    expect(canTransition(S.DRAFT, 'approve')).toBe(false);
    expect(canTransition(S.DRAFT, 'receive')).toBe(false);
    expect(canTransition(S.APPROVED, 'receive')).toBe(false);
    expect(canTransition(S.PENDING_APPROVAL, 'issue')).toBe(false);
    expect(canTransition(S.RECEIVED, 'receive')).toBe(false);
    expect(canTransition(S.ISSUED, 'edit')).toBe(false);
    expect(transitionError(S.CANCELLED, 'issue')).toBe(
      'A cancelled purchase order cannot be issued',
    );
    expect(transitionError(S.DRAFT, 'edit')).toBeNull();
  });

  it('can be cancelled until goods arrive', () => {
    for (const status of [S.DRAFT, S.PENDING_APPROVAL, S.APPROVED, S.ISSUED]) {
      expect(canTransition(status, 'cancel')).toBe(true);
    }
    expect(canTransition(S.PARTIALLY_RECEIVED, 'cancel')).toBe(false);
    expect(canTransition(S.RECEIVED, 'cancel')).toBe(false);
  });

  it('needs approval above the threshold (0 = every order)', () => {
    expect(statusAfterSubmit(100, 0)).toBe(S.PENDING_APPROVAL);
    expect(statusAfterSubmit(0, 0)).toBe(S.APPROVED);
    expect(statusAfterSubmit(500, 500)).toBe(S.APPROVED);
    expect(statusAfterSubmit(500.01, 500)).toBe(S.PENDING_APPROVAL);
  });

  it('totals lines, tax and shipping', () => {
    expect(
      computeOrderTotals(
        [
          { quantityOrdered: 3, unitCost: 1.335 },
          { quantityOrdered: 10, unitCost: 2 },
        ],
        2.5,
        5,
      ),
    ).toMatchObject({
      lineTotals: [4.01, 20],
      subtotal: 24.01,
      discountAmount: 0,
      taxAmount: 2.5,
      shippingCost: 5,
      total: 31.51,
    });
  });

  it('applies line discounts and line tax exactly', () => {
    const totals = computeOrderTotals(
      [
        // 3 × 19.99 = 59.97, −12.5% = 7.50 (7.49625) → 52.47, + 4.20 tax
        {
          quantityOrdered: 3,
          unitCost: 19.99,
          discountPercent: 12.5,
          taxAmount: 4.2,
        },
        { quantityOrdered: 7, unitCost: 0.1, taxAmount: 0.07 },
      ],
      1,
      0,
    );
    expect(totals.lines[0]).toEqual({
      subtotal: 52.47,
      discountAmount: 7.5,
      taxAmount: 4.2,
      total: 56.67,
    });
    expect(totals.lines[1]).toEqual({
      subtotal: 0.7,
      discountAmount: 0,
      taxAmount: 0.07,
      total: 0.77,
    });
    expect(totals).toMatchObject({
      subtotal: 53.17,
      discountAmount: 7.5,
      // line taxes + order-level tax
      taxAmount: 5.27,
      total: 58.44,
    });
    expect(netUnitCost({ unitCost: 19.99, discountPercent: 12.5 })).toBe(
      17.4913,
    );
  });

  it('closes partly or fully received orders, revises after approval', () => {
    expect(canTransition(S.PARTIALLY_RECEIVED, 'close')).toBe(true);
    expect(canTransition(S.RECEIVED, 'close')).toBe(true);
    expect(canTransition(S.ISSUED, 'close')).toBe(false);
    expect(canTransition(S.CLOSED, 'receive')).toBe(false);
    expect(canTransition(S.CLOSED, 'revise')).toBe(false);
    for (const status of [S.APPROVED, S.ISSUED, S.PARTIALLY_RECEIVED]) {
      expect(canTransition(status, 'revise')).toBe(true);
    }
    expect(canTransition(S.DRAFT, 'revise')).toBe(false);
  });
});

describe('short-close', () => {
  it('cancels only what is still outstanding, keeping received units', () => {
    const items = [
      {
        id: 'a',
        quantityOrdered: 10,
        quantityReceived: 4,
        quantityCancelled: 0,
      },
      {
        id: 'b',
        quantityOrdered: 5,
        quantityReceived: 5,
        quantityCancelled: 0,
      },
      // over-received: nothing to cancel
      {
        id: 'c',
        quantityOrdered: 2,
        quantityReceived: 3,
        quantityCancelled: 0,
      },
    ];
    expect(planShortClose(items)).toEqual([{ itemId: 'a', cancel: 6 }]);
    const after = items.map((i) =>
      i.id === 'a' ? { ...i, quantityCancelled: 6 } : i,
    );
    expect(after.every((i) => outstandingQuantity(i) === 0)).toBe(true);
    // Received quantities are untouched
    expect(after.map((i) => i.quantityReceived)).toEqual([4, 5, 3]);
    expect(statusAfterReceipt(after)).toBe(S.RECEIVED);
  });
});

describe('revisions after approval', () => {
  const received = [
    { variantId: 'v1', sku: 'A', quantityReceived: 4 },
    { variantId: 'v2', sku: 'B', quantityReceived: 0 },
  ];

  it('cannot drop a received line or order less than received', () => {
    expect(
      revisionError(received, [{ variantId: 'v2', quantityOrdered: 1 }]),
    ).toMatch(/A was already received/);
    expect(
      revisionError(received, [{ variantId: 'v1', quantityOrdered: 3 }]),
    ).toMatch(/4 unit\(s\) were already received/);
    expect(
      revisionError(received, [{ variantId: 'v1', quantityOrdered: 4 }]),
    ).toBeNull();
  });

  it('goes back to approval when the new total is above the threshold', () => {
    const lines = [
      { quantityOrdered: 10, quantityReceived: 4, quantityCancelled: 0 },
    ];
    expect(statusAfterRevision(S.ISSUED, 1200, 1000, lines)).toEqual({
      status: S.PENDING_APPROVAL,
      requiresApproval: true,
    });
    // At or below the threshold the order keeps its place
    expect(statusAfterRevision(S.APPROVED, 1000, 1000, lines)).toEqual({
      status: S.APPROVED,
      requiresApproval: false,
    });
    expect(statusAfterRevision(S.ISSUED, 900, 1000, lines)).toEqual({
      status: S.PARTIALLY_RECEIVED,
      requiresApproval: false,
    });
    // Threshold 0: every revision of a paid order needs approval
    expect(statusAfterRevision(S.APPROVED, 5, 0, lines).requiresApproval).toBe(
      true,
    );
  });
});

describe('goods receipt planning', () => {
  const items = [
    {
      id: 'l1',
      variantId: 'v1',
      quantityOrdered: 10,
      quantityReceived: 4,
      unitCost: 2,
    },
    {
      id: 'l2',
      variantId: 'v2',
      quantityOrdered: 5,
      quantityReceived: 0,
      unitCost: 3,
    },
  ];

  it('receives part of the outstanding quantity at the order cost', () => {
    const plan = planReceipt(items, [
      { purchaseOrderItemId: 'l1', quantity: 6 },
      { purchaseOrderItemId: 'l2', quantity: 2, unitCost: 3.5 },
    ]);
    expect(plan).toEqual({
      lines: [
        {
          item: items[0],
          quantity: 6,
          damagedQuantity: 0,
          damagedAccepted: false,
          stockQuantity: 6,
          unitCost: 2,
        },
        {
          item: items[1],
          quantity: 2,
          damagedQuantity: 0,
          damagedAccepted: false,
          stockQuantity: 2,
          unitCost: 3.5,
        },
      ],
      overTolerance: [],
    });
  });

  it('flags receiving more than is outstanding when there is no tolerance', () => {
    const plan = planReceipt(items, [
      { purchaseOrderItemId: 'l1', quantity: 7 },
    ]);
    expect(plan).toMatchObject({
      overTolerance: [
        { itemId: 'l1', receivedAfter: 11, maxWithinTolerance: 10 },
      ],
    });
  });

  it('accepts an over-receipt within the tolerance (% of ordered, rounded down)', () => {
    // 10 ordered, 15% → up to 11 in total (1.5 rounded down)
    expect(maxReceivableWithinTolerance({ quantityOrdered: 10 }, 15)).toBe(11);
    expect(
      planReceipt(items, [{ purchaseOrderItemId: 'l1', quantity: 7 }], 15),
    ).toMatchObject({ overTolerance: [] });
    expect(
      planReceipt(items, [{ purchaseOrderItemId: 'l1', quantity: 8 }], 15),
    ).toMatchObject({ overTolerance: [{ itemId: 'l1', receivedAfter: 12 }] });
    // Cancelled units are no longer expected
    expect(
      maxReceivableWithinTolerance(
        { quantityOrdered: 10, quantityCancelled: 4 },
        0,
      ),
    ).toBe(6);
  });

  it('puts damaged units into stock only when accepted', () => {
    const rejected = planReceipt(items, [
      {
        purchaseOrderItemId: 'l2',
        quantity: 3,
        damagedQuantity: 2,
        damagedAccepted: false,
      },
    ]);
    expect(rejected).toMatchObject({
      lines: [{ quantity: 3, damagedQuantity: 2, stockQuantity: 3 }],
      overTolerance: [],
    });
    const accepted = planReceipt(items, [
      {
        purchaseOrderItemId: 'l2',
        quantity: 3,
        damagedQuantity: 2,
        damagedAccepted: true,
      },
    ]);
    expect(accepted).toMatchObject({ lines: [{ stockQuantity: 5 }] });
    // Rejected damaged units never count as an over-receipt
    expect(
      planReceipt(items, [
        { purchaseOrderItemId: 'l2', quantity: 5, damagedQuantity: 9 },
      ]),
    ).toMatchObject({ overTolerance: [] });
  });

  it('refuses lines of another order, duplicates and empty receipts', () => {
    expect(
      planReceipt(items, [{ purchaseOrderItemId: 'nope', quantity: 1 }]),
    ).toHaveProperty('error');
    expect(
      planReceipt(items, [
        { purchaseOrderItemId: 'l2', quantity: 1 },
        { purchaseOrderItemId: 'l2', quantity: 1 },
      ]),
    ).toHaveProperty('error');
    expect(
      planReceipt(items, [{ purchaseOrderItemId: 'l2', quantity: 0 }]),
    ).toEqual({ error: 'Nothing to receive' });
  });

  it('is complete only when every line is fully received or cancelled', () => {
    expect(
      statusAfterReceipt([
        { quantityOrdered: 10, quantityReceived: 0 },
        { quantityOrdered: 5, quantityReceived: 0 },
      ]),
    ).toBe(S.ISSUED);
    expect(
      statusAfterReceipt([
        { quantityOrdered: 10, quantityReceived: 10 },
        { quantityOrdered: 5, quantityReceived: 2 },
      ]),
    ).toBe(S.PARTIALLY_RECEIVED);
    expect(
      statusAfterReceipt([
        { quantityOrdered: 10, quantityReceived: 10 },
        { quantityOrdered: 5, quantityReceived: 5 },
      ]),
    ).toBe(S.RECEIVED);
  });
});
