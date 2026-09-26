import {
  consumeLayers,
  inboundLayerQuantity,
  round4,
  weightedAverageCost,
} from './costing';

describe('costing', () => {
  describe('weightedAverageCost', () => {
    it('blends the on-hand cost with the received cost', () => {
      // (10 × 2 + 10 × 4) / 20
      expect(weightedAverageCost(10, 2, 10, 4)).toBe(3);
      // (3 × 1.5 + 1 × 2.1) / 4 = 1.65
      expect(weightedAverageCost(3, 1.5, 1, 2.1)).toBe(1.65);
    });

    it('rounds to 4 decimals', () => {
      // (1 × 1 + 2 × 2) / 3 = 1.6667
      expect(weightedAverageCost(1, 1, 2, 2)).toBe(1.6667);
    });

    it('uses the new cost when nothing (or less than nothing) is on hand', () => {
      expect(weightedAverageCost(0, 5, 10, 2)).toBe(2);
      expect(weightedAverageCost(-4, 5, 10, 2)).toBe(2);
    });

    it('uses the new cost when there was no cost yet', () => {
      expect(weightedAverageCost(8, null, 2, 3)).toBe(3);
      expect(weightedAverageCost(8, undefined, 2, 3)).toBe(3);
    });

    it('keeps the old cost when nothing is received', () => {
      expect(weightedAverageCost(8, 4, 0, 100)).toBe(4);
    });
  });

  describe('consumeLayers (FIFO)', () => {
    const layers = [
      { id: 'a', quantityRemaining: 5, unitCost: 2 },
      { id: 'b', quantityRemaining: 10, unitCost: 4 },
    ];

    it('takes the oldest layer first', () => {
      const result = consumeLayers(layers, 3, 9);
      expect(result.takes).toEqual([{ id: 'a', quantity: 3, unitCost: 2 }]);
      expect(result.unitCost).toBe(2);
      expect(result.uncovered).toBe(0);
    });

    it('spans layers and returns the weighted unit cost', () => {
      const result = consumeLayers(layers, 15, 9);
      expect(result.takes).toEqual([
        { id: 'a', quantity: 5, unitCost: 2 },
        { id: 'b', quantity: 10, unitCost: 4 },
      ]);
      expect(result.totalCost).toBe(50);
      expect(result.unitCost).toBe(3.3333);
    });

    it('costs units beyond the layers at the fallback cost', () => {
      const result = consumeLayers(layers, 20, 5);
      expect(result.uncovered).toBe(5);
      expect(result.totalCost).toBe(75);
      expect(result.unitCost).toBe(3.75);
    });

    it('skips empty layers and handles no stock at all', () => {
      expect(
        consumeLayers([{ id: 'x', quantityRemaining: 0, unitCost: 1 }], 2, 3),
      ).toEqual({ takes: [], uncovered: 2, totalCost: 6, unitCost: 3 });
      expect(consumeLayers([], 0, 3).unitCost).toBe(0);
    });
  });

  describe('inboundLayerQuantity', () => {
    it('layers every unit when stock was not negative', () => {
      expect(inboundLayerQuantity(0, 10)).toBe(10);
      expect(inboundLayerQuantity(4, 10)).toBe(10);
    });

    it('first fills a negative on-hand hole (units already sold)', () => {
      expect(inboundLayerQuantity(-3, 10)).toBe(7);
      expect(inboundLayerQuantity(-12, 10)).toBe(0);
    });
  });

  it('round4 avoids floating point noise', () => {
    expect(round4(0.1 + 0.2)).toBe(0.3);
  });
});

describe('costing with decimal (measured) quantities', () => {
  it('consumes FIFO layers by the kg without drift', () => {
    const result = consumeLayers(
      [
        { id: 'a', quantityRemaining: 0.1, unitCost: 10 },
        { id: 'b', quantityRemaining: 0.2, unitCost: 20 },
      ],
      0.3,
      99,
    );
    expect(result.takes).toEqual([
      { id: 'a', quantity: 0.1, unitCost: 10 },
      { id: 'b', quantity: 0.2, unitCost: 20 },
    ]);
    expect(result.uncovered).toBe(0);
    expect(result.totalCost).toBe(5);
    expect(result.unitCost).toBe(16.6667);
  });

  it('averages the cost over decimal quantities', () => {
    // 1.5 kg at 4.00 + 0.5 kg at 6.00 = 2 kg at 4.50
    expect(weightedAverageCost(1.5, 4, 0.5, 6)).toBe(4.5);
  });

  it('fills a hole below zero before layering decimals', () => {
    expect(inboundLayerQuantity(-0.2, 0.3)).toBe(0.1);
  });
});
