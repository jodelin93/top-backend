/**
 * Inventory costing math (R066). Pure functions, unit tested in costing.spec.ts.
 * Quantities may be decimal (measured items: kg, m, l); they are added and
 * subtracted exactly (see common/utils/quantity).
 */
import { addQty, subQty } from '../common/utils/quantity';

export type CostingMethod = 'average' | 'fifo';

// Costs are stored as NUMERIC(19,4)
export const round4 = (value: number): number =>
  Math.round((value + Number.EPSILON) * 10000) / 10000;

/**
 * Moving weighted average after receiving `quantity` units at `unitCost`:
 * (onHand × oldCost + quantity × unitCost) / (onHand + quantity).
 * With nothing (or less than nothing) on hand, or no previous cost, the new
 * units set the cost on their own.
 */
export function weightedAverageCost(
  onHand: number,
  oldCost: number | null | undefined,
  quantity: number,
  unitCost: number,
): number {
  if (quantity <= 0) return round4(oldCost ?? unitCost);
  if (onHand <= 0 || oldCost === null || oldCost === undefined) {
    return round4(unitCost);
  }
  return round4(
    (onHand * oldCost + quantity * unitCost) / addQty(onHand, quantity),
  );
}

export interface CostLayerLike {
  id: string;
  quantityRemaining: number;
  unitCost: number;
}

export interface LayerConsumption {
  // What to take from each layer, oldest first
  takes: { id: string; quantity: number; unitCost: number }[];
  // Units not covered by any layer (legacy stock or negative stock), costed at the fallback
  uncovered: number;
  totalCost: number;
  // Weighted cost per unit of everything consumed (0 when quantity is 0)
  unitCost: number;
}

/**
 * Consume `quantity` units from FIFO layers (already sorted oldest first).
 */
export function consumeLayers(
  layers: CostLayerLike[],
  quantity: number,
  fallbackCost: number,
): LayerConsumption {
  let remaining = Math.max(0, quantity);
  let totalCost = 0;
  const takes: LayerConsumption['takes'] = [];
  for (const layer of layers) {
    if (remaining === 0) break;
    const take = Math.min(remaining, Number(layer.quantityRemaining));
    if (take <= 0) continue;
    takes.push({ id: layer.id, quantity: take, unitCost: layer.unitCost });
    totalCost += take * layer.unitCost;
    remaining = subQty(remaining, take);
  }
  totalCost += remaining * fallbackCost;
  return {
    takes,
    uncovered: remaining,
    totalCost: round4(totalCost),
    unitCost: quantity > 0 ? round4(totalCost / quantity) : 0,
  };
}

/**
 * Units of an inbound movement that become a new cost layer. When the location
 * was below zero, the first units only fill that hole (they were already sold).
 */
export function inboundLayerQuantity(
  onHandBefore: number,
  quantity: number,
): number {
  return Math.max(0, Math.min(quantity, addQty(onHandBefore, quantity)));
}
