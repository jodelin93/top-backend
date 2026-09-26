import {
  expectedAtCount,
  lineVariance,
  movementsBetween,
  needsApproval,
  summarizeCount,
} from './stock-count.logic';

describe('stock count variance', () => {
  it('is counted minus expected, null when not counted', () => {
    expect(lineVariance({ expectedQuantity: 10, countedQuantity: 7 })).toBe(-3);
    expect(lineVariance({ expectedQuantity: 0, countedQuantity: 2 })).toBe(2);
    expect(
      lineVariance({ expectedQuantity: 5, countedQuantity: null }),
    ).toBeNull();
  });

  it('needs approval only above the tolerance', () => {
    const lines = [
      { expectedQuantity: 10, countedQuantity: 8 },
      { expectedQuantity: 3, countedQuantity: 3 },
    ];
    expect(needsApproval(lines, 0)).toBe(true);
    expect(needsApproval(lines, 1)).toBe(true);
    expect(needsApproval(lines, 2)).toBe(false);
  });

  it('ignores uncounted lines when deciding on approval', () => {
    expect(
      needsApproval([{ expectedQuantity: 50, countedQuantity: null }], 0),
    ).toBe(false);
  });

  it('treats surpluses like shortages', () => {
    expect(
      needsApproval([{ expectedQuantity: 1, countedQuantity: 5 }], 3),
    ).toBe(true);
  });

  it('summarises units and value', () => {
    expect(
      summarizeCount([
        { expectedQuantity: 10, countedQuantity: 8, unitCost: 2.5 },
        { expectedQuantity: 1, countedQuantity: 4, unitCost: 1 },
        { expectedQuantity: 6, countedQuantity: 6, unitCost: 3 },
        { expectedQuantity: 2, countedQuantity: null, unitCost: 3 },
      ]),
    ).toEqual({
      lines: 4,
      counted: 3,
      uncounted: 1,
      withVariance: 2,
      unitsOver: 3,
      unitsShort: 2,
      netUnits: 1,
      netValue: -2,
    });
  });
});

describe('stock count roll-forward', () => {
  const snapshotAt = '2026-09-24T08:00:00Z';

  it('a sale made while counting is not a variance', () => {
    // Snapshot 10; 2 sold at 09:00; the shelf is counted at 10:00: 8 found
    const net = movementsBetween(
      snapshotAt,
      [{ variantId: 'v', countedAt: '2026-09-24T10:00:00Z' }],
      [{ variantId: 'v', quantity: -2, movementDate: '2026-09-24T09:00:00Z' }],
    );
    const line = {
      expectedQuantity: 10,
      movementsSinceSnapshot: net.get('v') ?? 0,
      countedQuantity: 8,
    };
    expect(expectedAtCount(line)).toBe(8);
    expect(lineVariance(line)).toBe(0);
    // Without the roll-forward the sale would look like 2 missing units
    expect(lineVariance({ expectedQuantity: 10, countedQuantity: 8 })).toBe(-2);
  });

  it("only counts movements between the snapshot and each line's count", () => {
    const net = movementsBetween(
      snapshotAt,
      [
        { variantId: 'a', countedAt: '2026-09-24T10:00:00Z' },
        { variantId: 'b', countedAt: null },
      ],
      [
        // Before the snapshot: already in it
        { variantId: 'a', quantity: -5, movementDate: '2026-09-24T07:59:00Z' },
        { variantId: 'a', quantity: 6, movementDate: '2026-09-24T09:00:00Z' },
        { variantId: 'a', quantity: -1, movementDate: '2026-09-24T09:30:00Z' },
        // After the line was counted: on hand moves on, the count doesn't
        { variantId: 'a', quantity: -4, movementDate: '2026-09-24T11:00:00Z' },
        // Not counted: no roll-forward
        { variantId: 'b', quantity: -1, movementDate: '2026-09-24T09:00:00Z' },
      ],
    );
    expect(net.get('a')).toBe(5);
    expect(net.has('b')).toBe(false);
  });

  it('decides approval and the summary on the rolled-forward variance', () => {
    const lines = [
      { expectedQuantity: 10, movementsSinceSnapshot: -3, countedQuantity: 7 },
      { expectedQuantity: 4, movementsSinceSnapshot: 2, countedQuantity: 5 },
    ];
    expect(needsApproval(lines, 0)).toBe(true);
    expect(needsApproval(lines, 1)).toBe(false);
    expect(summarizeCount(lines)).toMatchObject({
      withVariance: 1,
      unitsShort: 1,
      netUnits: -1,
    });
  });
});
