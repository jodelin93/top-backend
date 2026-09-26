import { StockTransferStatus } from '../database/entities/stock-transfer.entity';
import {
  dispatchedUnitCost,
  isTransferLineBalanced,
  outstandingInTransit,
  overReceiptAllowance,
  planDispatch,
  planReceipt,
  planReturn,
  planTransferReceipt,
  planWriteOff,
  statusAfterArrival,
  TransferItemState,
  transferNeedsApproval,
  transferStatus,
  transferTransitionError,
  writeOffReasonError,
} from './transfer.logic';

const item = (
  id: string,
  requested: number,
  dispatched = 0,
  received = 0,
  writtenOff = 0,
): TransferItemState => ({
  id,
  variantId: `v-${id}`,
  quantityRequested: requested,
  quantityDispatched: dispatched,
  quantityReceived: received,
  quantityWrittenOff: writtenOff,
});

describe('transfer lifecycle', () => {
  it('only allows each step from the right status', () => {
    expect(
      transferTransitionError(StockTransferStatus.DRAFT, 'dispatch'),
    ).toBeNull();
    expect(
      transferTransitionError(StockTransferStatus.IN_TRANSIT, 'dispatch'),
    ).toMatch(/cannot be dispatched/);
    expect(
      transferTransitionError(StockTransferStatus.DRAFT, 'receive'),
    ).toMatch(/cannot be received/);
    expect(
      transferTransitionError(
        StockTransferStatus.PARTIALLY_RECEIVED,
        'receive',
      ),
    ).toBeNull();
    // Cancelling after dispatch returns the units in transit to the source
    expect(
      transferTransitionError(StockTransferStatus.IN_TRANSIT, 'cancel'),
    ).toBeNull();
    expect(
      transferTransitionError(StockTransferStatus.RECEIVED, 'cancel'),
    ).toMatch(/cannot be cancelled/);
    expect(
      transferTransitionError(StockTransferStatus.REQUESTED, 'dispatch'),
    ).toMatch(/requested transfer cannot be dispatched/);
    expect(
      transferTransitionError(StockTransferStatus.REQUESTED, 'approve'),
    ).toBeNull();
    expect(
      transferTransitionError(
        StockTransferStatus.PARTIALLY_DISPATCHED,
        'dispatch',
      ),
    ).toBeNull();
    expect(
      transferTransitionError(StockTransferStatus.RECEIVED, 'writeOff'),
    ).not.toBeNull();
  });

  it('dispatches everything requested by default', () => {
    const plan = planDispatch([item('a', 5), item('b', 2)]);
    expect('lines' in plan && plan.lines.map((l) => l.quantity)).toEqual([
      5, 2,
    ]);
  });

  it('dispatches part of a line and skips zero lines', () => {
    const plan = planDispatch(
      [item('a', 5), item('b', 2)],
      [
        { itemId: 'a', quantity: 3 },
        { itemId: 'b', quantity: 0 },
      ],
    );
    expect(
      'lines' in plan && plan.lines.map((l) => [l.item.id, l.quantity]),
    ).toEqual([['a', 3]]);
  });

  it('never dispatches more than requested', () => {
    expect(
      planDispatch([item('a', 5)], [{ itemId: 'a', quantity: 6 }]),
    ).toHaveProperty('error', expect.stringMatching(/Only 5/) as string);
    expect(
      planDispatch([item('a', 5)], [{ itemId: 'x', quantity: 1 }]),
    ).toHaveProperty('error');
  });

  it('receives in parts up to what is in transit', () => {
    const items = [item('a', 5, 4), item('b', 2, 2)];
    const first = planTransferReceipt(items, [{ itemId: 'a', quantity: 3 }]);
    expect('lines' in first).toBe(true);
    items[0].quantityReceived = 3;
    expect(statusAfterArrival(items)).toBe(
      StockTransferStatus.PARTIALLY_RECEIVED,
    );

    expect(
      planTransferReceipt(items, [{ itemId: 'a', quantity: 2 }]),
    ).toHaveProperty('error', expect.stringMatching(/Only 1/) as string);

    // Default: everything still outstanding
    const rest = planTransferReceipt(items);
    expect('lines' in rest && rest.lines.map((l) => l.quantity)).toEqual([
      1, 2,
    ]);
  });

  it('closes the transfer once everything arrived or was written off', () => {
    const items = [item('a', 5, 4, 3), item('b', 2, 2, 2)];
    expect(outstandingInTransit(items[0])).toBe(1);
    const writeOff = planWriteOff(items);
    expect('lines' in writeOff && writeOff.lines).toEqual([
      { item: items[0], quantity: 1 },
    ]);
    items[0].quantityWrittenOff = 1;
    expect(statusAfterArrival(items)).toBe(StockTransferStatus.RECEIVED);
  });

  it('stays in transit until something arrives', () => {
    expect(statusAfterArrival([item('a', 5, 5)])).toBe(
      StockTransferStatus.IN_TRANSIT,
    );
  });

  it('refuses an empty plan', () => {
    expect(planTransferReceipt([item('a', 5, 5, 5)])).toEqual({
      error: 'Nothing to be received',
    });
  });

  it('requires a reason to write off units in transit', () => {
    expect(writeOffReasonError(undefined)).toMatch(/reason is required/);
    expect(writeOffReasonError('   ')).toMatch(/reason is required/);
    expect(writeOffReasonError('x'.repeat(501))).toMatch(/too long/);
    expect(writeOffReasonError('Box lost by the courier')).toBeNull();
  });

  it('keeps shipped = received + written off + in transit', () => {
    const line = item('a', 10, 8, 5, 2);
    expect(outstandingInTransit(line)).toBe(1);
    expect(isTransferLineBalanced(line)).toBe(true);
    // Writing off more than is still in transit breaks the balance
    expect(isTransferLineBalanced(item('a', 10, 8, 5, 4))).toBe(false);
    expect(planWriteOff([line], [{ itemId: 'a', quantity: 2 }])).toEqual({
      error: 'Only 1 unit(s) can be written off on a line (2 given)',
    });
  });
});

describe('transfer workflow (approval, multi-dispatch, receipt conditions)', () => {
  it('needs approval by setting: never, above the threshold, always', () => {
    expect(transferNeedsApproval('never', 0, 1e9)).toBe(false);
    expect(transferNeedsApproval('threshold', 500, 500)).toBe(false);
    expect(transferNeedsApproval('threshold', 500, 500.01)).toBe(true);
    expect(transferNeedsApproval('always', 0, 0)).toBe(true);
  });

  it('dispatches in several goes up to what was requested', () => {
    const line = item('a', 10);
    const first = planDispatch([line], [{ itemId: 'a', quantity: 4 }]);
    expect('lines' in first).toBe(true);
    line.quantityDispatched = 4;
    expect(transferStatus([line], { dispatchComplete: false })).toBe(
      StockTransferStatus.PARTIALLY_DISPATCHED,
    );
    // Default: the rest
    const second = planDispatch([line]);
    expect('lines' in second && second.lines[0].quantity).toBe(6);
    expect(planDispatch([line], [{ itemId: 'a', quantity: 7 }])).toHaveProperty(
      'error',
      'Only 6 unit(s) can be dispatched on a line (7 given)',
    );
    line.quantityDispatched = 10;
    expect(transferStatus([line], { dispatchComplete: false })).toBe(
      StockTransferStatus.IN_TRANSIT,
    );
  });

  it('a last dispatch drops the rest of the request', () => {
    const line = item('a', 10, 4);
    expect(transferStatus([line], { dispatchComplete: true })).toBe(
      StockTransferStatus.IN_TRANSIT,
    );
  });

  it('weights the line cost over several dispatches', () => {
    expect(dispatchedUnitCost(0, null, 4, 2)).toBe(2);
    expect(dispatchedUnitCost(4, 2, 6, 3)).toBe(2.6);
  });

  it('records damaged and missing separately; missing stay in transit', () => {
    const line = item('a', 10, 10);
    const plan = planReceipt(
      [line],
      [{ itemId: 'a', quantity: 6, damaged: 2, missing: 2 }],
      0,
    );
    expect(plan).toEqual({
      lines: [{ item: line, good: 6, damaged: 2, missing: 2, over: 0 }],
      needsApproval: false,
    });
    line.quantityReceived = 6;
    line.quantityDamaged = 2;
    // Missing units are still in transit until found or written off
    expect(outstandingInTransit(line)).toBe(2);
    expect(statusAfterArrival([line])).toBe(
      StockTransferStatus.PARTIALLY_RECEIVED,
    );
    expect(
      planReceipt([line], [{ itemId: 'a', quantity: 1, missing: 2 }], 0),
    ).toHaveProperty('error');
  });

  it('allows an over-receipt within the tolerance, approval above it', () => {
    const line = item('a', 10, 10);
    expect(overReceiptAllowance(line, 10)).toBe(1);
    const within = planReceipt([line], [{ itemId: 'a', quantity: 11 }], 10);
    expect(within).toMatchObject({ needsApproval: false });
    expect('lines' in within && within.lines[0].over).toBe(1);
    expect(
      planReceipt([line], [{ itemId: 'a', quantity: 12 }], 10),
    ).toMatchObject({ needsApproval: true });
    expect(
      planReceipt([line], [{ itemId: 'a', quantity: 11 }], 0),
    ).toMatchObject({ needsApproval: true });
    expect(
      planReceipt([line], [{ itemId: 'a', quantity: 11, missing: 1 }], 50),
    ).toHaveProperty('error');
  });

  it('returns what is still in transit when cancelled after dispatch', () => {
    const lines = [item('a', 10, 8, 5, 1), item('b', 3, 3, 3)];
    expect(planReturn(lines)).toEqual([{ item: lines[0], quantity: 2 }]);
    lines[0].quantityReturned = 2;
    // dispatched 8 = received 5 + written off 1 + returned 2
    expect(isTransferLineBalanced(lines[0])).toBe(true);
    expect(outstandingInTransit(lines[0])).toBe(0);
  });
});
