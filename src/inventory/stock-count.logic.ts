/**
 * Stock count rules (R065). Pure functions, unit tested in stock-count.logic.spec.ts.
 * Quantities may be decimal for measured items (kg, m, l): computed exactly.
 */
import { addQty, subQty } from '../common/utils/quantity';

export interface CountLine {
  // On hand at the snapshot
  expectedQuantity: number;
  countedQuantity: number | null;
  // Net movements at the location between the snapshot and when the line was
  // counted (sales, receipts while counting); null/0 = none
  movementsSinceSnapshot?: number | null;
}

/**
 * Roll-forward: what should have been on the shelf when the line was counted
 * = snapshot + movements posted between the snapshot and the count
 */
export const expectedAtCount = (line: CountLine): number =>
  addQty(
    Number(line.expectedQuantity),
    Number(line.movementsSinceSnapshot ?? 0),
  );

/**
 * counted − expected at count time, or null for a line that was not counted
 * (not adjusted). A sale made while counting is not a variance.
 */
export function lineVariance(line: CountLine): number | null {
  return line.countedQuantity === null || line.countedQuantity === undefined
    ? null
    : subQty(Number(line.countedQuantity), expectedAtCount(line));
}

export interface CountMovement {
  variantId: string;
  // Signed at the counted location: + in, − out
  quantity: number;
  movementDate: Date | string;
}

/**
 * Net movement per variant between the snapshot and each line's countedAt
 * (movements of the count's own posting excluded by the caller)
 */
export function movementsBetween(
  snapshotAt: Date | string,
  lines: { variantId: string; countedAt: Date | string | null }[],
  movements: CountMovement[],
): Map<string, number> {
  const from = new Date(snapshotAt).getTime();
  const countedAt = new Map(
    lines
      .filter((l) => l.countedAt)
      .map((l) => [l.variantId, new Date(l.countedAt!).getTime()]),
  );
  const result = new Map<string, number>();
  for (const movement of movements) {
    const until = countedAt.get(movement.variantId);
    if (until === undefined) continue;
    const at = new Date(movement.movementDate).getTime();
    if (at > from && at <= until) {
      result.set(
        movement.variantId,
        addQty(result.get(movement.variantId) ?? 0, Number(movement.quantity)),
      );
    }
  }
  return result;
}

/**
 * A count needs inventory.count.approve when any line's |variance| is above the
 * store's tolerance (in units; tolerance 0 = any difference).
 */
export function needsApproval(lines: CountLine[], tolerance: number): boolean {
  return lines.some((line) => {
    const variance = lineVariance(line);
    return variance !== null && Math.abs(variance) > tolerance;
  });
}

export interface CountSummary {
  lines: number;
  counted: number;
  uncounted: number;
  // Lines whose counted quantity differs from the expected one
  withVariance: number;
  unitsOver: number;
  unitsShort: number;
  netUnits: number;
  // Net variance value at the unit costs given (0 when unknown)
  netValue: number;
}

export function summarizeCount(
  lines: (CountLine & { unitCost?: number | null })[],
): CountSummary {
  const summary: CountSummary = {
    lines: lines.length,
    counted: 0,
    uncounted: 0,
    withVariance: 0,
    unitsOver: 0,
    unitsShort: 0,
    netUnits: 0,
    netValue: 0,
  };
  for (const line of lines) {
    const variance = lineVariance(line);
    if (variance === null) {
      summary.uncounted++;
      continue;
    }
    summary.counted++;
    if (variance !== 0) summary.withVariance++;
    if (variance > 0) summary.unitsOver += variance;
    if (variance < 0) summary.unitsShort -= variance;
    summary.netUnits += variance;
    summary.netValue += variance * Number(line.unitCost ?? 0);
  }
  summary.netValue = Math.round(summary.netValue * 100) / 100;
  return summary;
}
