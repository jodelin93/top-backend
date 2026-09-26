/**
 * Reorder suggestions (spec §10, phase 2). Pure function, unit tested in
 * payables.logic.spec.ts.
 */
export interface ReorderInput {
  onHand: number;
  // Outstanding on open purchase orders
  onOrder: number;
  reorderPoint: number | null;
  reorderQuantity: number | null;
  maxStockLevel: number | null;
  // Supplier's minimum order quantity
  minOrderQty?: number | null;
}

/**
 * Units to order, or null when no order is needed. A variant needs ordering when
 * its stock position (on hand + on order) is at or below the reorder point.
 * Quantity: the reorder quantity, else enough to reach the maximum stock level,
 * else enough to get back above the reorder point; at least the supplier's
 * minimum order quantity.
 */
export function suggestedReorderQuantity(input: ReorderInput): number | null {
  if (input.reorderPoint == null) return null;
  const position = input.onHand + input.onOrder;
  if (position > input.reorderPoint) return null;
  let quantity: number;
  if (input.reorderQuantity && input.reorderQuantity > 0) {
    quantity = input.reorderQuantity;
  } else if (input.maxStockLevel && input.maxStockLevel > position) {
    quantity = input.maxStockLevel - position;
  } else {
    quantity = input.reorderPoint - position + 1;
  }
  if (input.minOrderQty && quantity < input.minOrderQty) {
    quantity = input.minOrderQty;
  }
  return quantity > 0 ? quantity : null;
}
